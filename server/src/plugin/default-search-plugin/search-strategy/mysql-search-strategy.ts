import { Brackets, Connection, SelectQueryBuilder } from 'typeorm';

import { SearchInput, SearchResult } from '../../../../../shared/generated-types';
import { ID } from '../../../../../shared/shared-types';
import { unique } from '../../../../../shared/unique';
import { RequestContext } from '../../../api/common/request-context';
import { SearchIndexItem } from '../search-index-item.entity';

import { mapToSearchResult } from './map-to-search-result';
import { SearchStrategy } from './search-strategy';

/**
 * A weighted fulltext search for MySQL / MariaDB.
 */
export class MysqlSearchStrategy implements SearchStrategy {
    private readonly minTermLength = 2;

    constructor(private connection: Connection) {}

    async getFacetValueIds(ctx: RequestContext, input: SearchInput): Promise<ID[]> {
        const facetValuesQb = this.connection
            .getRepository(SearchIndexItem)
            .createQueryBuilder('si')
            .select('GROUP_CONCAT(si.facetValueIds)', 'allFacetValues');

        const facetValuesResult = await this.applyTermAndFilters(facetValuesQb, input).getRawOne();
        const allFacetValues = facetValuesResult ? facetValuesResult.allFacetValues || '' : '';
        return unique(allFacetValues.split(',').filter(x => x !== ''));
    }

    async getSearchResults(ctx: RequestContext, input: SearchInput): Promise<SearchResult[]> {
        const take = input.take || 25;
        const skip = input.skip || 0;
        const sort = input.sort;
        const qb = this.connection.getRepository(SearchIndexItem).createQueryBuilder('si');
        this.applyTermAndFilters(qb, input);
        if (input.term && input.term.length > this.minTermLength) {
            qb.orderBy('score', 'DESC');
        }
        if (sort) {
            if (sort.name) {
                qb.addOrderBy('productName', sort.name);
            }
            if (sort.price) {
                qb.addOrderBy('price', sort.price);
            }
        }

        return qb
            .take(take)
            .skip(skip)
            .getRawMany()
            .then(res => res.map(r => mapToSearchResult(r, ctx.channel.currencyCode)));
    }

    async getTotalCount(ctx: RequestContext, input: SearchInput): Promise<number> {
        const innerQb = this.applyTermAndFilters(
            this.connection.getRepository(SearchIndexItem).createQueryBuilder('si'),
            input,
        );

        const totalItemsQb = this.connection
            .createQueryBuilder()
            .select('COUNT(*) as total')
            .from(`(${innerQb.getQuery()})`, 'inner')
            .setParameters(innerQb.getParameters());
        return totalItemsQb.getRawOne().then(res => res.total);
    }

    private applyTermAndFilters(
        qb: SelectQueryBuilder<SearchIndexItem>,
        input: SearchInput,
    ): SelectQueryBuilder<SearchIndexItem> {
        const { term, facetIds } = input;

        qb.where('1 = 1');
        if (term && term.length > this.minTermLength) {
            qb.addSelect(`IF (sku LIKE :like_term, 10, 0)`, 'sku_score')
                .addSelect(
                    `
                            (SELECT sku_score) +
                            MATCH (productName) AGAINST (:term) * 2 +
                            MATCH (productVariantName) AGAINST (:term) * 1.5 +
                            MATCH (description) AGAINST (:term)* 1`,
                    'score',
                )
                .andWhere(
                    new Brackets(qb1 => {
                        qb1.where('sku LIKE :like_term')
                            .orWhere('MATCH (productName) AGAINST (:term)')
                            .orWhere('MATCH (productVariantName) AGAINST (:term)')
                            .orWhere('MATCH (description) AGAINST (:term)');
                    }),
                )
                .setParameters({ term, like_term: `%${term}%` });
        }
        if (facetIds) {
            for (const id of facetIds) {
                const placeholder = '_' + id;
                qb.andWhere(`FIND_IN_SET(:${placeholder}, facetValueIds)`, { [placeholder]: id });
            }
        }
        if (input.groupByProduct === true) {
            qb.groupBy('productId');
        }
        return qb;
    }
}
