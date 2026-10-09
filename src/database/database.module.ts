import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { KEY_PROVIDER, keyProviderFromEnv } from '../security/crypto/key-provider.js';
import { APP_POOL, createPool, WORKER_POOL } from './pools.js';
import { APP_TX, TransactionRunner, WORKER_TX } from './transaction-runner.js';

/**
 * API processes import DatabaseModule.forApi(); worker processes import
 * DatabaseModule.forWorker(). A process therefore only ever holds the
 * credentials of ONE runtime role, and never the owner/migration role.
 */
@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  static forApi() {
    return {
      module: DatabaseModule,
      providers: [
        { provide: APP_POOL, useFactory: () => createPool('app') },
        { provide: APP_TX, useFactory: (pool: Pool) => new TransactionRunner(pool), inject: [APP_POOL] },
        { provide: KEY_PROVIDER, useFactory: keyProviderFromEnv },
      ],
      exports: [APP_TX, APP_POOL, KEY_PROVIDER],
    };
  }

  static forWorker() {
    return {
      module: DatabaseModule,
      providers: [
        { provide: WORKER_POOL, useFactory: () => createPool('worker') },
        { provide: APP_POOL, useExisting: WORKER_POOL }, // for shutdown hook only
        { provide: WORKER_TX, useFactory: (pool: Pool) => new TransactionRunner(pool), inject: [WORKER_POOL] },
        { provide: KEY_PROVIDER, useFactory: keyProviderFromEnv },
      ],
      exports: [WORKER_TX, KEY_PROVIDER],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
