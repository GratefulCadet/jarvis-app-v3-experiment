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

let mainWindow = null

let savedPipBounds = null
let commandCenterBounds = null

function getWorkAreaBounds() {
  const currentBounds = mainWindow.getBounds()

  const currentDisplay =
    screen.getDisplayMatching(currentBounds)

  return {
    ...currentDisplay.workArea,
  }
}

/*
  PiP → Command Center 전환 준비.

  아직 Window 크기는 바꾸지 않는다.

  여기서는:
  1. 현재 PiP 위치 저장
  2. Command Center workArea 계산
  3. PiP Core가 workArea 중앙에서
     얼마나 떨어져 있는지 계산
*/
function prepareCommandCenter() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return null
  }

  const pipBounds = mainWindow.getBounds()

  savedPipBounds = {
    ...pipBounds,
  }

  commandCenterBounds =
    getWorkAreaBounds()

  const pipCenterX =
    pipBounds.x +
    pipBounds.width / 2

  const pipCenterY =
    pipBounds.y +
    pipBounds.height / 2

  const commandCenterX =
    commandCenterBounds.x +
    commandCenterBounds.width / 2

  const commandCenterY =
    commandCenterBounds.y +
    commandCenterBounds.height / 2

  return {
    offsetX:
      pipCenterX - commandCenterX,

    offsetY:
      pipCenterY - commandCenterY,
  }
}

/*
  PiP → Command Center.

  애니메이션하지 않는다.

  Native Window bounds는
  여기서 딱 한 번만 바뀐다.
*/
function expandCommandCenter() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return false
  }

  if (!commandCenterBounds) {
    commandCenterBounds =
      getWorkAreaBounds()
  }

  mainWindow.setAlwaysOnTop(false)
  mainWindow.setResizable(false)

  mainWindow.setBackgroundColor(
    '#00000000',
  )

  mainWindow.setBounds(
    commandCenterBounds,
    false,
  )

  return true
}

/*
  Command Center → PiP.

  CSS 모션이 이미 PiP 위치까지
  도착한 뒤 호출된다.

  따라서 Native Window는
  마지막에 한 번만 크기를 변경한다.
*/
function collapseToPip() {
  if (
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return false
  }

  const currentBounds =
    mainWindow.getBounds()

  const targetBounds =
    savedPipBounds ?? {
      x: currentBounds.x,
      y: currentBounds.y,
      width: PIP_SIZE.width,
      height: PIP_SIZE.height,
    }

  mainWindow.setBackgroundColor(
    '#00000000',
  )

  mainWindow.setBounds(
    targetBounds,
    false,
  )

  mainWindow.setResizable(false)
  mainWindow.setAlwaysOnTop(true)

  commandCenterBounds = null

  return true
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
    fullscreenable: false,

    hasShadow: false,
    skipTaskbar: false,

    show: false,

    webPreferences: {
      preload: path.join(
        __dirname,
        'preload.cjs',
      ),

      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (app.isPackaged) {
    mainWindow.loadFile(
      path.join(
        __dirname,
        '../dist/index.html',
      ),
    )
  } else {
    mainWindow.loadURL(
      'http://localhost:5173',
    )
  }

  mainWindow.once(
    'ready-to-show',
    () => {
      mainWindow.show()
    },
  )
}

app.whenReady().then(() => {
  ipcMain.handle(
    'window:prepare-command-center',
    prepareCommandCenter,
  )

  ipcMain.handle(
    'window:expand-command-center',
    expandCommandCenter,
  )

  ipcMain.handle(
    'window:collapse-to-pip',
    collapseToPip,
  )

  createWindow()

  app.on('activate', () => {
    if (
      BrowserWindow
        .getAllWindows()
        .length === 0
    ) {
      createWindow()
    }
  })
})

app.on(
  'window-all-closed',
  () => {
    if (
      process.platform !== 'darwin'
    ) {
      app.quit()
    }
  },
)