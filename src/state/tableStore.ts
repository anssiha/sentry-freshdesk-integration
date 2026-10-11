import { RestError, TableClient, type TableEntityResult } from '@azure/data-tables';
import type { TokenCredential } from '@azure/identity';
import type { CursorState, Mapping, StatePort } from '../sync/types';

const CURSOR_ROW = '_cursor';

interface CursorEntity {
  partitionKey: string;
  rowKey: string;
  cursor: string;
  baseline: string;
  updatedAt: string;
}

interface MappingEntity {
  partitionKey: string;
  rowKey: string;
  status: 'pending' | 'done';
  claimedAt?: string;
  runId?: string;
  /** Stored as strings to avoid Int32 inference by the Table service. */
  ticketId?: string;
  eventCount?: string;
}

function isStatus(err: unknown, status: number): boolean {
  return err instanceof RestError && err.statusCode === status;
}

/**
 * One table, partitioned by route name.
 * RowKey "_cursor" holds the route cursor; every other row maps a Sentry issue ID to a ticket.
 */
export class TableStateStore implements StatePort {
  constructor(private readonly table: TableClient) {}

  static fromConnectionString(connectionString: string, tableName: string): TableStateStore {
    const allowInsecureConnection = connectionString.includes('UseDevelopmentStorage=true') || connectionString.includes('127.0.0.1');
    return new TableStateStore(TableClient.fromConnectionString(connectionString, tableName, { allowInsecureConnection }));
  }

  static fromUrl(tableServiceUrl: string, tableName: string, credential: TokenCredential): TableStateStore {
    return new TableStateStore(new TableClient(tableServiceUrl, tableName, credential));
  }

  async ensureTable(): Promise<void> {
    try {
      await this.table.createTable();
    } catch (err) {
      if (!isStatus(err, 409)) throw err;
    }
  }

  private async getEntity<T extends object>(pk: string, rk: string): Promise<TableEntityResult<T> | null> {
    try {
      return await this.table.getEntity<T>(pk, rk);
    } catch (err) {
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  async getCursor(route: string): Promise<CursorState | null> {
    const e = await this.getEntity<CursorEntity>(route, CURSOR_ROW);
    return e ? { cursor: e.cursor, baseline: e.baseline ?? e.cursor, updatedAt: e.updatedAt } : null;
  }

  async setCursor(route: string, state: CursorState): Promise<void> {
    await this.table.upsertEntity<CursorEntity>({ partitionKey: route, rowKey: CURSOR_ROW, ...state }, 'Replace');
  }

  async getMapping(route: string, sentryId: string): Promise<Mapping | null> {
    const e = await this.getEntity<MappingEntity>(route, sentryId);
    if (!e) return null;
    const etag = e.etag;
    if (e.status === 'done') {
      return { status: 'done', ticketId: Number(e.ticketId), eventCount: Number(e.eventCount ?? 0), etag };
    }
    return { status: 'pending', claimedAt: e.claimedAt ?? new Date(0).toISOString(), runId: e.runId ?? '', etag };
  }

  async claim(route: string, sentryId: string, runId: string, now: Date): Promise<boolean> {
    try {
      await this.table.createEntity<MappingEntity>({
        partitionKey: route,
        rowKey: sentryId,
        status: 'pending',
        claimedAt: now.toISOString(),
        runId,
      });
      return true;
    } catch (err) {
      if (isStatus(err, 409)) return false;
      throw err;
    }
  }

  async takeOver(route: string, sentryId: string, etag: string, runId: string, now: Date): Promise<boolean> {
    try {
      await this.table.updateEntity<MappingEntity>(
        { partitionKey: route, rowKey: sentryId, status: 'pending', claimedAt: now.toISOString(), runId },
        'Replace',
        { etag },
      );
      return true;
    } catch (err) {
      if (isStatus(err, 412) || isStatus(err, 404)) return false;
      throw err;
    }
  }

  async complete(route: string, sentryId: string, ticketId: number, eventCount: number): Promise<void> {
    await this.table.upsertEntity<MappingEntity>(
      { partitionKey: route, rowKey: sentryId, status: 'done', ticketId: String(ticketId), eventCount: String(eventCount) },
      'Replace',
    );
  }

  async updateEventCount(route: string, sentryId: string, eventCount: number): Promise<void> {
    await this.table.updateEntity({ partitionKey: route, rowKey: sentryId, eventCount: String(eventCount) }, 'Merge');
  }

  async release(route: string, sentryId: string): Promise<void> {
    try {
      await this.table.deleteEntity(route, sentryId);
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
    }
  }
}
