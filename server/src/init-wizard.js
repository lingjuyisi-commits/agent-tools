const config = require('./config');

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--db-path' && argv[i + 1]) {
      args.dbPath = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function runWizard() {
  // Dynamic import for inquirer (ESM module)
  const { default: inquirer } = await import('inquirer');

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'dbType',
      message: 'Database type:',
      choices: [
        { name: 'SQLite (default, no setup needed)', value: 'sqlite' },
        { name: 'MySQL', value: 'mysql' },
        { name: 'PostgreSQL', value: 'pg' }
      ],
      default: 'sqlite'
    }
  ]);

  let database;

  if (answers.dbType === 'sqlite') {
    const sqliteAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'filename',
        message: 'SQLite file path:',
        default: config.defaultDbPath()
      }
    ]);
    database = {
      client: 'better-sqlite3',
      connection: { filename: sqliteAnswers.filename },
      useNullAsDefault: true
    };
  } else {
    const client = answers.dbType === 'mysql' ? 'mysql2' : 'pg';
    const defaultPort = answers.dbType === 'mysql' ? 3306 : 5432;

    const dbAnswers = await inquirer.prompt([
      { type: 'input', name: 'host', message: 'Database host:', default: 'localhost' },
      { type: 'number', name: 'port', message: 'Database port:', default: defaultPort },
      { type: 'input', name: 'database', message: 'Database name:', default: 'agent_tools' },
      { type: 'input', name: 'user', message: 'Database user:', default: 'root' },
      { type: 'password', name: 'password', message: 'Database password:', mask: '*' }
    ]);

    database = {
      client,
      connection: {
        host: dbAnswers.host,
        port: dbAnswers.port,
        database: dbAnswers.database,
        user: dbAnswers.user,
        password: dbAnswers.password
      }
    };
  }

  const serverAnswers = await inquirer.prompt([
    {
      type: 'number',
      name: 'port',
      message: 'Server port:',
      default: 3000
    }
  ]);

  const cfg = {
    server: { port: serverAnswers.port },
    database
  };

  config.save(cfg);
  console.log(`\nConfig saved to ${config.CONFIG_FILE}\n`);
  return cfg;
}

module.exports = { runWizard, parseCliArgs };
