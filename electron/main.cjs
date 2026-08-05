const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
} = require('electron')

const path = require('path')

const PIP_SIZE = {
  width: 280,
  height: 280,
}

const COMMAND_CENTER_SIZE = {
  width: 1100,
  height: 700,
}

const TRANSITION_DURATION_MS = 420

let mainWindow
let savedPipBounds = null
let isAnimating = false

function easeInOutCubic(progress) {
  if (progress < 0.5) {
    return 4 * progress * progress * progress
  }

  return 1 - Math.pow(-2 * progress + 2, 3) / 2
}

function interpolate(start, end, progress) {
  return Math.round(start + (end - start) * progress)
}

function getCenteredBounds(width, height) {
  const currentBounds = mainWindow.getBounds()
  const currentDisplay = screen.getDisplayMatching(currentBounds)
  const { workArea } = currentDisplay

  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  }
}

function animateWindowBounds(targetBounds, duration) {
  return new Promise((resolve) => {
    const startBounds = mainWindow.getBounds()
    const startedAt = Date.now()

    function updateFrame() {
      if (!mainWindow || mainWindow.isDestroyed()) {
        resolve()
        return
      }

      const elapsed = Date.now() - startedAt
      const progress = Math.min(elapsed / duration, 1)
      const easedProgress = easeInOutCubic(progress)

      mainWindow.setBounds({
        x: interpolate(
          startBounds.x,
          targetBounds.x,
          easedProgress,
        ),
        y: interpolate(
          startBounds.y,
          targetBounds.y,
          easedProgress,
        ),
        width: interpolate(
          startBounds.width,
          targetBounds.width,
          easedProgress,
        ),
        height: interpolate(
          startBounds.height,
          targetBounds.height,
          easedProgress,
        ),
      })

      if (progress < 1) {
        setTimeout(updateFrame, 16)
        return
      }

      mainWindow.setBounds(targetBounds)
      resolve()
    }

    updateFrame()
  })
}

async function openCommandCenter() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    isAnimating
  ) {
    return
  }

  isAnimating = true

  // 사용자가 배치한 PiP 위치를 기억한다.
  savedPipBounds = mainWindow.getBounds()

  const commandCenterBounds = getCenteredBounds(
    COMMAND_CENTER_SIZE.width,
    COMMAND_CENTER_SIZE.height,
  )

  mainWindow.setAlwaysOnTop(false)
  mainWindow.setResizable(true)
  mainWindow.setBackgroundColor('#00000000')

  await animateWindowBounds(
    commandCenterBounds,
    TRANSITION_DURATION_MS,
  )

  mainWindow.setBackgroundColor('#030507')
  mainWindow.setResizable(false)

  isAnimating = false
}

async function returnToPip() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    isAnimating
  ) {
    return
  }

  isAnimating = true

  const currentBounds = mainWindow.getBounds()

  const targetBounds = savedPipBounds ?? {
    x: currentBounds.x,
    y: currentBounds.y,
    width: PIP_SIZE.width,
    height: PIP_SIZE.height,
  }

  mainWindow.setResizable(true)

  // 축소 중 PiP 상태가 되면 뒤가 투명하게 보이도록 미리 전환한다.
  mainWindow.setBackgroundColor('#00000000')

  await animateWindowBounds(
    targetBounds,
    TRANSITION_DURATION_MS,
  )

  mainWindow.setResizable(false)
  mainWindow.setAlwaysOnTop(true)

  isAnimating = false
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: PIP_SIZE.width,
    height: PIP_SIZE.height,

    frame: false,
    transparent: true,
    backgroundColor: '#00000000',

    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    hasShadow: false,

    show: false,

    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (app.isPackaged) {
    mainWindow.loadFile(
      path.join(__dirname, '../dist/index.html'),
    )
  } else {
    mainWindow.loadURL('http://localhost:5173')
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}

app.whenReady().then(() => {
  ipcMain.on(
    'window:open-command-center',
    openCommandCenter,
  )

  ipcMain.on(
    'window:return-to-pip',
    returnToPip,
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})