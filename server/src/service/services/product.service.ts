import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection, FindConditions, In } from 'typeorm';

import {
    CreateProductInput,
    DeletionResponse,
    DeletionResult,
    UpdateProductInput,
} from '../../../../shared/generated-types';
import { ID, PaginatedList } from '../../../../shared/shared-types';
import { RequestContext } from '../../api/common/request-context';
import { EntityNotFoundError } from '../../common/error/errors';
import { ListQueryOptions } from '../../common/types/common-types';
import { Translated } from '../../common/types/locale-types';
import { assertFound } from '../../common/utils';
import { ProductOptionGroup } from '../../entity/product-option-group/product-option-group.entity';
import { ProductTranslation } from '../../entity/product/product-translation.entity';
import { Product } from '../../entity/product/product.entity';
import { EventBus } from '../../event-bus/event-bus';
import { CatalogModificationEvent } from '../../event-bus/events/catalog-modification-event';
import { AssetUpdater } from '../helpers/asset-updater/asset-updater';
import { ListQueryBuilder } from '../helpers/list-query-builder/list-query-builder';
import { TranslatableSaver } from '../helpers/translatable-saver/translatable-saver';
import { getEntityOrThrow } from '../helpers/utils/get-entity-or-throw';
import { translateDeep } from '../helpers/utils/translate-entity';

import { ChannelService } from './channel.service';
import { FacetValueService } from './facet-value.service';
import { ProductCategoryService } from './product-category.service';
import { ProductVariantService } from './product-variant.service';
import { TaxRateService } from './tax-rate.service';

@Injectable()
export class ProductService {
    private readonly relations = [
        'featuredAsset',
        'assets',
        'optionGroups',
        'channels',
        'facetValues',
        'facetValues.facet',
    ];

    constructor(
        @InjectConnection() private connection: Connection,
        private channelService: ChannelService,
        private assetUpdater: AssetUpdater,
        private productVariantService: ProductVariantService,
        private productCategoryService: ProductCategoryService,
        private facetValueService: FacetValueService,
        private taxRateService: TaxRateService,
        private listQueryBuilder: ListQueryBuilder,
        private translatableSaver: TranslatableSaver,
        private eventBus: EventBus,
    ) {}

    async findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<Product> & { categoryId?: string | null },
    ): Promise<PaginatedList<Translated<Product>>> {
        let where: FindConditions<Product> | undefined;
        if (options && options.categoryId) {
            where = {
                id: In(await this.getProductIdsInCategory(options.categoryId)),
            };
        }
        return this.listQueryBuilder
            .build(Product, options, {
                relations: this.relations,
                channelId: ctx.channelId,
                where: { ...where, deletedAt: null },
            })
            .getManyAndCount()
            .then(async ([products, totalItems]) => {
                const items = products.map(product =>
                    translateDeep(product, ctx.languageCode, [
                        'optionGroups',
                        'facetValues',
                        ['facetValues', 'facet'],
                    ]),
                );
                return {
                    items,
                    totalItems,
                };
            });
    }

    async findOne(ctx: RequestContext, productId: ID): Promise<Translated<Product> | undefined> {
        const product = await this.connection.manager.findOne(Product, productId, {
            relations: this.relations,
            where: {
                deletedAt: null,
            },
        });
        if (!product) {
            return;
        }
        return translateDeep(product, ctx.languageCode, [
            'optionGroups',
            'facetValues',
            ['facetValues', 'facet'],
        ]);
    }

    async create(ctx: RequestContext, input: CreateProductInput): Promise<Translated<Product>> {
        const product = await this.translatableSaver.create({
            input,
            entityType: Product,
            translationType: ProductTranslation,
            beforeSave: async p => {
                this.channelService.assignToChannels(p, ctx);
                if (input.facetValueIds) {
                    p.facetValues = await this.facetValueService.findByIds(input.facetValueIds);
                }
                await this.assetUpdater.updateEntityAssets(p, input);
            },
        });
        this.eventBus.publish(new CatalogModificationEvent(ctx, product));
        return assertFound(this.findOne(ctx, product.id));
    }

    async update(ctx: RequestContext, input: UpdateProductInput): Promise<Translated<Product>> {
        await getEntityOrThrow(this.connection, Product, input.id);
        const product = await this.translatableSaver.update({
            input,
            entityType: Product,
            translationType: ProductTranslation,
            beforeSave: async p => {
                if (input.facetValueIds) {
                    p.facetValues = await this.facetValueService.findByIds(input.facetValueIds);
                }
                await this.assetUpdater.updateEntityAssets(p, input);
            },
        });
        this.eventBus.publish(new CatalogModificationEvent(ctx, product));
        return assertFound(this.findOne(ctx, product.id));
    }

    async softDelete(ctx: RequestContext, productId: ID): Promise<DeletionResponse> {
        const product = await getEntityOrThrow(this.connection, Product, productId);
        await this.connection.getRepository(Product).update({ id: productId }, { deletedAt: new Date() });
        this.eventBus.publish(new CatalogModificationEvent(ctx, product));
        return {
            result: DeletionResult.DELETED,
        };
    }

    async addOptionGroupToProduct(
        ctx: RequestContext,
        productId: ID,
        optionGroupId: ID,
    ): Promise<Translated<Product>> {
        const product = await this.getProductWithOptionGroups(productId);
        const optionGroup = await this.connection.getRepository(ProductOptionGroup).findOne(optionGroupId);
        if (!optionGroup) {
            throw new EntityNotFoundError('ProductOptionGroup', optionGroupId);
        }

        if (Array.isArray(product.optionGroups)) {
            product.optionGroups.push(optionGroup);
        } else {
            product.optionGroups = [optionGroup];
        }

        await this.connection.manager.save(product);
        return assertFound(this.findOne(ctx, productId));
    }

    async removeOptionGroupFromProduct(
        ctx: RequestContext,
        productId: ID,
        optionGroupId: ID,
    ): Promise<Translated<Product>> {
        const product = await this.getProductWithOptionGroups(productId);
        product.optionGroups = product.optionGroups.filter(g => g.id !== optionGroupId);

        await this.connection.manager.save(product);
        return assertFound(this.findOne(ctx, productId));
    }

    private async getProductIdsInCategory(categoryId: ID): Promise<ID[]> {
        const facetValueIds = await this.productCategoryService.getFacetValueIdsForCategory(categoryId);
        const qb = this.connection
            .getRepository(Product)
            .createQueryBuilder('product')
            .select(['product.id'])
            .innerJoin('product.facetValues', 'facetValue', 'facetValue.id IN (:...facetValueIds)', {
                facetValueIds,
            })
            .groupBy('product.id')
            .having('count(distinct facetValue.id) = :idCount', { idCount: facetValueIds.length });

        const productIds = await qb.getRawMany().then(rows => rows.map(r => r.product_id));
        return productIds;
    }

    private async getProductWithOptionGroups(productId: ID): Promise<Product> {
        const product = await this.connection
            .getRepository(Product)
            .findOne(productId, { relations: ['optionGroups'], where: { deletedAt: null } });
        if (!product) {
            throw new EntityNotFoundError('Product', productId);
        }
        return product;
    }
}
