#!/usr/bin/env node

const config = require('../src/config');
const { runWizard, parseCliArgs } = require('../src/init-wizard');
const { createDb } = require('../src/db');
const { buildApp } = require('../src/app');
const { startDailyAggregation } = require('../src/jobs/daily-aggregation');

async function main() {
  // Check for CLI args that can skip wizard
  const cliArgs = parseCliArgs(process.argv.slice(2));

  if (!config.exists()) {
    if (cliArgs.port || cliArgs.dbPath) {
      // Build config from CLI args, skip wizard
      const cfg = {
        server: { port: cliArgs.port || 3000 },
        database: {
          client: 'better-sqlite3',
          connection: {
            filename: cliArgs.dbPath || config.defaultDbPath()
          },
          useNullAsDefault: true
        }
      };
      config.save(cfg);
      console.log('Config saved from CLI arguments.');
    } else {
      console.log('First run detected. Starting setup wizard...\n');
      await runWizard();
    }
  }

  const cfg = config.load();

  // Apply CLI port override even if config exists
  if (cliArgs.port) {
    cfg.server.port = cliArgs.port;
  }

  // Create database connection and run migrations
  const db = createDb(cfg);

  console.log('Running database migrations...');
  await db.migrate.latest({
    directory: require('path').join(__dirname, '..', 'migrations')
  });
  console.log('Migrations complete.');

  // Sync adminUsers from config → allowed_users table
  if (cfg.auth?.adminUsers?.length) {
    for (const login of cfg.auth.adminUsers) {
      const exists = await db('allowed_users').where('login', login).first();
      if (!exists) {
        await db('allowed_users').insert({ login, name: '', role: 'admin', created_by: 'config' });
        console.log(`  Admin user added: ${login}`);
      } else if (exists.role !== 'admin') {
        await db('allowed_users').where('login', login).update({ role: 'admin' });
        console.log(`  Admin user promoted: ${login}`);
      }
    }
  }

  // Build and start the server
  const app = buildApp(db, cfg);

  // Start daily aggregation cron job
  startDailyAggregation(db);

  try {
    const address = await app.listen({
      port: cfg.server.port,
      host: '0.0.0.0'
    });
    console.log(`Agent Tools Server listening on ${address}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await app.close();
    await db.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
