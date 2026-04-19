import { powerSaveBlocker, app } from 'electron'

import { createLogger } from './logger'

const log = createLogger({ component: 'PowerSaveBlockerService' })

class PowerSaveBlockerService {
  private blockerId: number | null = null

  enable(): void {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) {
      return
    }

    this.blockerId = powerSaveBlocker.start('prevent-display-sleep')
    log.info('Enabled keep-awake blocker', { blockerId: this.blockerId })
  }

  disable(): void {
    if (this.blockerId === null) return
    if (powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId)
      log.info('Disabled keep-awake blocker', { blockerId: this.blockerId })
    }
    this.blockerId = null
  }

  isEnabled(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)
  }
}

export const powerSaveBlockerService = new PowerSaveBlockerService()

app.on('will-quit', () => {
  powerSaveBlockerService.disable()
})
