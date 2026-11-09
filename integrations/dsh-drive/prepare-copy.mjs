/** Build a reviewable dsh-drive package copy; never edits an installed profile/package.
 * Usage: node prepare-copy.mjs /absolute/source /absolute/new-copy
 */
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, join } from 'node:path'
const [source, target, configFile] = process.argv.slice(2)
if (!configFile || !isAbsolute(configFile) || !existsSync(configFile)) throw new Error('Explicit existing absolute driver config required')
if (!source || !target || !isAbsolute(source) || !isAbsolute(target) || existsSync(target)) throw new Error('Need absolute existing source and NEW destination')
if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name !== 'dsh-drive') throw new Error('Not dsh-drive')
const baseline = { 'src/driver.mjs': '3a83b5c2f25d904663ed255937555884611f522cf98a00ae775a71ac2ba36225', 'bin/dsh-drive.mjs': '840288c713fead4077cd258c2ac2fc28f2c69ef411bfc42d7d84ec3300fc6b5f' }
for (const [file, hash] of Object.entries(baseline)) if (createHash('sha256').update(readFileSync(join(source, file))).digest('hex') !== hash) throw new Error(`Source changed: ${file}; review/rebase before applying`)
cpSync(realpathSync(source), target, { recursive: true, errorOnExist: true, force: false })
const change = (file, old, replacement) => {
 const path = join(target, file), text = readFileSync(path, 'utf8')
 if (text.split(old).length !== 2) throw new Error(`Expected one patch target: ${file}`)
 writeFileSync(path, text.replace(old, replacement))
}
change('src/driver.mjs', "import { createDecider, pickOption } from './permissions.mjs';", "import { createDecider, pickOption } from './permissions.mjs';\nimport { assertDriveWorkspaceAllowed } from './protected-workspaces.mjs';")
change('src/driver.mjs', "  if (!workspace) throw new Error('runDrive: 缺少 workspace');", "  if (!workspace) throw new Error('runDrive: 缺少 workspace');\n  assertDriveWorkspaceAllowed(path.resolve(workspace));")
change('bin/dsh-drive.mjs', "import { runDrive, killCurrentPi } from '../src/driver.mjs';", "import { runDrive, killCurrentPi } from '../src/driver.mjs';\nimport { assertDriveWorkspaceAllowed } from '../src/protected-workspaces.mjs';")
change('bin/dsh-drive.mjs', '      const env = buildPiEnv({ cfg, line });', "      assertDriveWorkspaceAllowed(path.resolve(r.workspace));\n      assertDriveWorkspaceAllowed(path.resolve(process.env.PI_DRIVE_WORKSPACE || r.workspace));\n      const env = buildPiEnv({ cfg, line });")
writeFileSync(join(target, 'src/protected-workspaces.mjs'), readFileSync(new URL('./protected-workspaces.mjs', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
manifest.name = '@local/dsh-drive-nightshift'
manifest.version = '0.1.1-nightshift.0'
manifest.engines.dsh = '^0.2.2-rc.1'
manifest.dsh.bundle = { patch: './cordis.patch.yml' }
manifest.exports['./locale/*.json'] = './locale/*.json'; manifest.exports['./icon'] = './icon.svg'
manifest.files = ['src', 'bin', 'plugin', 'tools', 'docs', 'README.md', 'config.example.json', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']
writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
// Disable the old row using plugin_manager before installation; no profile files are edited here.
writeFileSync(join(target, 'cordis.patch.yml'), `- insert:\n    - id: dsh-drive-nightshift\n      name: '@local/dsh-drive-nightshift'\n      config:\n        configFile: ${JSON.stringify(configFile)}\n        allowRun: true\n        maxConcurrent: 4\n`)
change('plugin/client.js', "id: 'dsh-drive',", "id: '@local/dsh-drive-nightshift',")
mkdirSync(join(target, 'locale'), { recursive: true })
for (const [locale, title, description] of [['en','Drive console','Drive isolated Pi workspaces; protects fixed-session nightshift workspace boundaries.'],['zh','驾驶台','驾驶独立 Pi 工作区；阻止进入由单会话夜班控制器接管的固定工作区。']]) writeFileSync(join(target, `locale/${locale}.json`), JSON.stringify({ meta: { title, description } }, null, 2) + '\n')
writeFileSync(join(target, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="14" fill="#164e63"/><circle cx="32" cy="30" r="17" fill="none" stroke="#67e8f9" stroke-width="5"/><circle cx="32" cy="30" r="5" fill="#67e8f9"/><path d="M17 24l15 6 15-6M32 35v12" fill="none" stroke="#67e8f9" stroke-width="4"/><path d="M45 39h11v13H45z" fill="#fbbf24"/><path d="M47 39v-4a3.5 3.5 0 017 0v4" fill="none" stroke="#fbbf24" stroke-width="3"/></svg>\n')
console.log(JSON.stringify({ prepared: resolve(target), baseline, changes: ['driver and CLI exclusion', 'bounded local registry', 'bundle metadata'] }))
