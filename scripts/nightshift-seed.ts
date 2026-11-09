/** Offline initializer for a NEW isolated nightshift store. Refuses to replace any existing database. */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { loadNightConfig } from '../src/nightshift/config.ts'

const file = process.argv[2]
if (!file || !isAbsolute(file)) throw new Error('usage: node --experimental-transform-types scripts/nightshift-seed.ts /absolute/bootstrap.json')
const input = z.object({ nightshiftConfig: z.string(), stateDir: z.string(), botCli: z.string(), ownerOpenId: z.string().regex(/^ou_[A-Za-z0-9]+$/) }).strict()
  .parse(JSON.parse(readFileSync(file, 'utf8')))
if (!isAbsolute(input.stateDir) || !isAbsolute(input.botCli)) throw new Error('Absolute stateDir and botCli required')
const config = loadNightConfig(input.nightshiftConfig)
if (!config.enabled) throw new Error('Explicit enabled configuration required; DAY_MANUAL remains the initial mode')
const database = join(input.stateDir, 'orchestrator.sqlite')
if (existsSync(database)) throw new Error('Refusing to replace an existing store; use management API for reviewed updates')
const store = new Store(database)
try {
  store.saveSettings(SettingsSchema.parse({ paused: false,
    sources: { feishu: { enabled: true, config: { cli: input.botCli, chats: [], directMessages: true, otherChats: 'none' } },
      github: { enabled: false, config: {} }, gitlab: { enabled: false, config: {} } },
    policy: { rules: [], sources: { feishu: { allowed: [{ id: input.ownerOpenId }], admission: {}, syncChat: '' }, github: { allowed: [] }, gitlab: { allowed: [] } } },
    eval: { mode: 'off' }, executor: { maxWorkers: 1, prepare: '', blockedCommands: [] } }))
  console.log(JSON.stringify({ seeded: database, mode: 'DAY_MANUAL (controller default)', workspace: config.workspace, groups: 'none', vcsSources: 'off', tasks: 0 }))
} finally { store.close() }
