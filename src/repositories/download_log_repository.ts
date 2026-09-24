import { DownloadLog } from '../db/models/index.js';

export class DownloadLogRepository {
    async find_by_team_key_date(team_id: string, download_key: string, date: string) {
        return DownloadLog.findOne({
            where: { team_id, download_key, date },
            raw: true,
        });
    }

    async create(team_id: string, download_key: string, date: string): Promise<void> {
        await DownloadLog.findOrCreate({
            where: { team_id, download_key, date },
            defaults: { team_id, download_key, date },
        });
    }
}
