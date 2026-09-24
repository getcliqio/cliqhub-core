import { Org } from '../db/models/index.js';

export class OrgRepository {
    async find_by_id(id: string) {
        return Org.findByPk(id, { attributes: ['id', 'slug', 'display_name', 'created_at'], raw: true });
    }

    async find_by_slug(slug: string) {
        return Org.findOne({ where: { slug }, attributes: ['id', 'slug', 'display_name', 'created_at'], raw: true });
    }

    async create(slug: string, display_name: string): Promise<string> {
        const row = await Org.create({ slug, display_name });
        return row.id;
    }

    async update_display_name(id: string, display_name: string): Promise<void> {
        await Org.update({ display_name }, { where: { id } });
    }

    async delete_by_id(id: string): Promise<void> {
        await Org.destroy({ where: { id } });
    }
}
