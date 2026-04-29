import { Notification, BrowserWindow, app, nativeImage } from 'electron'
import { join } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'NotificationService' })

interface SessionNotificationData {
  projectName: string
  sessionName: string
  projectId: string
  worktreeId: string
  sessionId: string
}

type PendingUserFeedbackKind = 'question' | 'approval'

function createNotificationIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png'))
}

class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private unreadCount = 0
  private queuedSessionIds = new Set<string>()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window

    // Clear badge when window gains focus
    window.on('focus', () => {
      this.clearBadge()
    })
  }

  showSessionComplete(data: SessionNotificationData): void {
    if (this.queuedSessionIds.has(data.sessionId)) {
      log.info('Skipping completion notification because session still has queued follow-up', {
        sessionId: data.sessionId
      })
      return
    }

    this.showNotification({
      data,
      body: `"${data.sessionName}" completed`
    })
  }

  showPendingUserFeedback(data: SessionNotificationData, kind: PendingUserFeedbackKind): void {
    this.showNotification({
      data,
      body:
        kind === 'question'
          ? `"${data.sessionName}" needs your answer`
          : `"${data.sessionName}" needs your permission`
    })
  }

  setSessionQueuedState(sessionId: string, queued: boolean): void {
    if (!sessionId) return

    if (queued) {
      this.queuedSessionIds.add(sessionId)
      return
    }

    this.queuedSessionIds.delete(sessionId)
  }

  private showNotification({ data, body }: { data: SessionNotificationData; body: string }): void {
    if (!Notification.isSupported()) {
      log.warn('Notifications not supported on this platform')
      return
    }

    log.info('Showing session notification', {
      projectName: data.projectName,
      sessionName: data.sessionName,
      body
    })

    const notification = new Notification({
      title: data.projectName,
      body,
      icon: createNotificationIcon(),
      silent: false
    })

    notification.on('click', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show()
        this.mainWindow.focus()
        this.mainWindow.webContents.send('notification:navigate', {
          projectId: data.projectId,
          worktreeId: data.worktreeId,
          sessionId: data.sessionId
        })
      }
    })

    notification.show()

    this.unreadCount++
    app.dock?.setBadge(String(this.unreadCount))
  }

  private clearBadge(): void {
    this.unreadCount = 0
    app.dock?.setBadge('')
  }
}

export const notificationService = new NotificationService()
