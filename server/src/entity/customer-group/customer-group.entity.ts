import { Column, Entity, ManyToMany } from 'typeorm';

import { DeepPartial } from '../../../../shared/shared-types';
import { VendureEntity } from '../base/base.entity';
import { Customer } from '../customer/customer.entity';

/**
 * @description
 * A grouping of {@link Customer}s which enables features such as group-based promotions
 * or tax rules.
 *
 * @docsCategory entities
 */
@Entity()
export class CustomerGroup extends VendureEntity {
    constructor(input?: DeepPartial<CustomerGroup>) {
        super(input);
    }

    @Column() name: string;

    @ManyToMany(type => Customer)
    customers: Customer[];
}
