import { ipcMain, shell } from 'electron'
import { createLogger } from '../services/logger'
import {
  installSkill,
  listHubSkills,
  listInstalledSkills,
  readSkillContent,
  uninstallSkill
} from '../services/skill-service'
import {
  addRemoteHub,
  listHubs,
  refreshHub,
  removeRemoteHub
} from '../services/hub-service'
import { detectAgentSdks } from '../services/system-info'
import type {
  AddHubResult,
  HubId,
  InstallSkillBatchResult,
  ProviderAvailability,
  ReadSkillContentResult,
  RefreshHubResult,
  RemoveHubResult,
  SkillProvider,
  SkillScope,
  UninstallSkillResult
} from '@shared/types/skill'

const log = createLogger({ component: 'SkillHandlers' })

export function registerSkillHandlers(): void {
  // ── Hubs ────────────────────────────────────────────────────────────────
  ipcMain.handle('skill:listHubs', async () => {
    try {
      const hubs = await listHubs()
      return { success: true, hubs }
    } catch (err) {
      log.error('skill:listHubs failed', { error: err })
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        hubs: []
      }
    }
  })

  ipcMain.handle(
    'skill:addHub',
    async (
      _event,
      args: { repo: string; ref?: string; name?: string }
    ): Promise<AddHubResult> => {
      return addRemoteHub(args)
    }
  )

  ipcMain.handle(
    'skill:removeHub',
    async (_event, { hubId }: { hubId: string }): Promise<RemoveHubResult> => {
      return removeRemoteHub(hubId)
    }
  )

  ipcMain.handle(
    'skill:refreshHub',
    async (_event, { hubId }: { hubId: HubId }): Promise<RefreshHubResult> => {
      return refreshHub(hubId)
    }
  )

  // ── Skills ──────────────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:listSkills',
    async (_event, { hubId }: { hubId: HubId }) => {
      try {
        const skills = await listHubSkills(hubId)
        return { success: true, skills }
      } catch (err) {
        log.error('skill:listSkills failed', { error: err, hubId })
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
          skills: []
        }
      }
    }
  )

  ipcMain.handle(
    'skill:listInstalled',
    async (_event, { scope }: { scope: SkillScope }) => {
      try {
        const skills = await listInstalledSkills(scope)
        return { success: true, skills }
      } catch (err) {
        log.error('skill:listInstalled failed', { error: err, scope })
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
          skills: []
        }
      }
    }
  )

  ipcMain.handle(
    'skill:install',
    async (
      _event,
      {
        hubId,
        skillId,
        providers,
        scope,
        overwrite
      }: {
        hubId: HubId
        skillId: string
        providers: SkillProvider[]
        /**
         * Scope shape WITHOUT `provider` — the handler fans the request out
         * across each requested provider, attaching the right provider field
         * when calling the service. Keeps the dialog payload compact.
         */
        scope: { kind: SkillScope['kind']; path?: string }
        overwrite?: boolean
      }
    ): Promise<InstallSkillBatchResult> => {
      const results: InstallSkillBatchResult['results'] = []
      for (const provider of providers) {
        const fullScope: SkillScope =
          scope.kind === 'user'
            ? { provider, kind: 'user' }
            : { provider, kind: scope.kind, path: scope.path ?? '' }
        const res = await installSkill({ hubId, skillId }, fullScope, { overwrite })
        results.push({ provider, ...res })
      }
      return { results }
    }
  )

  ipcMain.handle(
    'skill:uninstall',
    async (
      _event,
      { skillId, scope }: { skillId: string; scope: SkillScope }
    ): Promise<UninstallSkillResult> => {
      return uninstallSkill(skillId, scope)
    }
  )

  ipcMain.handle('skill:detectProviders', async (): Promise<{
    success: true
    availability: ProviderAvailability
  }> => {
    const raw = detectAgentSdks()
    return {
      success: true,
      availability: {
        'claude-code': raw.claude,
        codex: raw.codex,
        opencode: raw.opencode
      }
    }
  })

  ipcMain.handle(
    'skill:readContent',
    async (_event, { absPath }: { absPath: string }): Promise<ReadSkillContentResult> => {
      return readSkillContent(absPath)
    }
  )

  ipcMain.handle(
    'skill:openLocation',
    async (_event, { absPath }: { absPath: string }) => {
      try {
        shell.showItemInFolder(absPath)
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }
  )
}
