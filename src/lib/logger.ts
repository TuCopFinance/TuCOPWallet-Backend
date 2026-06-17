type Level = 'debug' | 'info' | 'warn' | 'error'
type LogFn = (msg: string, data?: unknown) => void

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel = process.env.NODE_ENV === 'production' ? LEVELS.warn : LEVELS.debug

export type Logger = Record<Level, LogFn>

const noop: LogFn = () => {}

export function createLogger(namespace: string): Logger {
  const tag = `[${namespace}]`
  const make = (level: Level): LogFn => {
    if (LEVELS[level] < minLevel) return noop
    const target =
      level === 'warn' ? console.warn : level === 'error' ? console.error : console.log
    return target.bind(console, tag) as LogFn
  }
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  }
}
