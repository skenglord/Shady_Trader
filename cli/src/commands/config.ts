// cli/src/commands/config.ts
import { Command } from 'commander';
import chalk from 'chalk';
import { envSchema } from '../../../backend/config/validation.js';

export const configCmd = new Command('config').description('Inspect bot configuration');

configCmd.command('list').description('List current (parsed) env config').action(() => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(chalk.red('Env validation failed:'), parsed.error.errors);
    process.exitCode = 1;
    return;
  }
  for (const [k, v] of Object.entries(parsed.data)) {
    const masked = /KEY|TOKEN|SECRET|PASSWORD/.test(k) && v ? '***' : v;
    console.log(`${chalk.cyan(k)}=${masked}`);
  }
});

configCmd.command('get <key>').description('Get one config value').action((key: string) => {
  const parsed = envSchema.safeParse(process.env);
  const data: any = parsed.success ? parsed.data : {};
  console.log(data[key] ?? chalk.gray('(unset)'));
});

configCmd.command('validate').description('Validate env against schema').action(() => {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) console.log(chalk.green('✓ env valid'));
  else { console.error(chalk.red('✗ env invalid'), parsed.error.errors); process.exitCode = 1; }
});
