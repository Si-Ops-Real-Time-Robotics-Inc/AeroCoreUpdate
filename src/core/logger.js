/** Minimal logger — switching to pino/winston later only touches this file. */
const write = (level, args) => {
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(`${new Date().toISOString()} [${level.toUpperCase()}]`, ...args);
};

export const logger = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};
