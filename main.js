const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
} = require("electron");
const { initialize, enable } = require("@electron/remote/main");
const path = require("path");
const fs = require("fs").promises;
const { exec } = require("child_process");

initialize();

const configDir = app.getPath("userData");
const configPath = path.join(configDir, "config.json");

const EXE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "utils")
  : path.join(__dirname, "utils");

const defaultConfig = {
  mod_dir: "",
  xxmi_exe: "",
  game_exe: "",
  auto_refresh_mods: true,
  theme: "light",
  is_custom_theme_enabled: false,
  custom_theme_css: "",
  resizeSettings: {
    character: { width: 150, height: 140 },
    mod: { width: 400, height: 300 },
  },
};

const runningProcesses = new Map();
let mainWindow;
const APP_WINDOW_TITLE = "Waves Skin Mod Manager";
let TARGET_WINDOW_TITLE = "";
let oldFocusTitle = null;
let currentFocusTitle = null;
let isGameOpened = false;

// Utility Functions ==============================================
async function getCurrentFocusTitle() {
  return new Promise((resolve) => {
    const exePath = path.join(EXE_DIR, "get_active_window.exe");
    exec(
      `"${exePath}"`,
      { encoding: "utf-8", windowsHide: true, shell: true },
      (err, stdout) => {
        if (err || !stdout || stdout.includes("No active window found")) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

function focusTargetWindow() {
  try {
    const exePath = path.join(EXE_DIR, "focus_game.exe");
    exec(`"${exePath}"`, { windowsHide: true, shell: true }, (error) => {
      if (error) console.error("Focus failed:", error);
      else console.log("Focused target window");
    });
  } catch (err) {
    console.error("Focus command failed:", err);
  }
}

async function getTargetWindowTitle() {
  return new Promise((resolve) => {
    const exePath = path.join(EXE_DIR, "game_title.exe");
    exec(
      `"${exePath}"`,
      { encoding: "utf-8", windowsHide: true, shell: true, cwd: EXE_DIR },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
        } else {
          TARGET_WINDOW_TITLE = stdout.trim();
          resolve(TARGET_WINDOW_TITLE);
        }
      }
    );
  });
}

async function ensureConfigExists() {
  try {
    await fs.access(configPath);
  } catch (err) {
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`Created default config at ${configPath}`);
  }
}

function createWindow() {
  console.log("Creating window:", Date.now());
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 900,
    minHeight: 750,
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
    alwaysOnTop: false,
    show: false, // Start hidden
    backgroundColor: "#00000000",
  });
  enable(win.webContents);

  win.webContents.on("did-finish-load", async () => {
    console.log("Window content loaded:", Date.now());
    await ensureConfigExists();
    const configData = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(configData);
    const mergedConfig = { ...defaultConfig, ...config };
    win.webContents.send("config-loaded", mergedConfig);
    // Show immediately after load for testing
    console.log("Initial show attempt:", Date.now());
    win.setOpacity(1.0);
    win.center();
    win.show();
    win.focus();
    console.log("Window should be visible at:", win.getPosition(), Date.now());
  });

  const htmlPath = path.join(__dirname, "src", "index.html");
  console.log("Loading HTML from:", htmlPath);
  win.loadFile(htmlPath).catch((err) => {
    console.error("Failed to load index.html:", err);
    win.loadURL(
      `data:text/html,<h1>Error: Could not load index.html</h1><p>${err.message}</p>`
    );
  });

  win.on("blur", () => {
    win.setAlwaysOnTop(false);
    setTimeout(() => {
      console.log(`Blur event: ${Date.now()}, Visible: ${win.isVisible()}`);
    }, 5000);
  });

  win.on("show", () => {
    console.log("Show event:", win.getPosition(), Date.now());
  });

  win.on("hide", () => {
    console.log("Hide event:", Date.now());
  });

  return win;
}

const waitForRender = (win) => {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) {
      setTimeout(resolve, 50);
    } else {
      win.webContents.once("did-finish-load", () => setTimeout(resolve, 50));
    }
  });
};

let isF5Processing = false;
let lastF5Time = 0;
const F5_DEBOUNCE_MS = 200;

const handleF5 = async () => {
  console.log("F5 key pressed");
  const now = Date.now();
  if (isF5Processing || now - lastF5Time < F5_DEBOUNCE_MS || !mainWindow) {
    console.log("F5 skipped - processing or debounced:", now);
    return;
  }
  TARGET_WINDOW_TITLE = await getTargetWindowTitle();

  const newTitle = (await getCurrentFocusTitle()) || "";
  oldFocusTitle = currentFocusTitle;
  currentFocusTitle = newTitle;

  console.log(TARGET_WINDOW_TITLE, currentFocusTitle, oldFocusTitle);
  isF5Processing = true;
  lastF5Time = now;

  try {
    console.log("F5 pressed, Visible:", mainWindow.isVisible(), now);
    if (mainWindow.isVisible()) {
      if (isGameOpened && currentFocusTitle === TARGET_WINDOW_TITLE) {
        console.log("Window already visible, bringing to top");
        mainWindow.setAlwaysOnTop(true, "pop-up-menu");
        mainWindow.focus();
      } else if (
        isGameOpened &&
        (currentFocusTitle === TARGET_WINDOW_TITLE ||
          currentFocusTitle === APP_WINDOW_TITLE)
      ) {
        console.log("Hiding mainWindow:", now);
        mainWindow.setOpacity(0);
        mainWindow.hide();
        mainWindow.setAlwaysOnTop(false, "pop-up-menu");
        focusTargetWindow();
      }
    } else {
      if (isGameOpened && currentFocusTitle === TARGET_WINDOW_TITLE) {
        console.log("Showing mainWindow:", now);
        mainWindow.setPosition(-9999, -9999);
        mainWindow.setOpacity(0);
        mainWindow.showInactive();
        mainWindow.center();
        mainWindow.setAlwaysOnTop(true, "pop-up-menu");
        mainWindow.show();
        await waitForRender(mainWindow);
        mainWindow.setOpacity(1);
        setTimeout(() => {
          mainWindow.focusOnWebView();
        }, 100);
        console.log("Show completed:", mainWindow.getPosition(), Date.now());
      } else {
        isGameOpened = false;
        mainWindow.setOpacity(1.0);
        mainWindow.show();
      }
    }
    //
  } catch (err) {
    console.error("F5 handler error:", err, Date.now());
    mainWindow.setOpacity(1.0);
    mainWindow.center();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
    console.log("Fallback show:", mainWindow.getPosition(), Date.now());
  } finally {
    isF5Processing = false;
    console.log("F5 processing done:", Date.now());
  }
};

app.whenReady().then(async () => {
  console.log("App starting:", Date.now());
  mainWindow = createWindow();

  currentFocusTitle = (await getCurrentFocusTitle()) || "";
  oldFocusTitle = currentFocusTitle;
  await getTargetWindowTitle();

  console.log("Initial focus title:", currentFocusTitle);

  setInterval(async () => {
    const newTitle = await getCurrentFocusTitle();

    if (newTitle === null || newTitle === "") {
      return;
    }

    if (newTitle === TARGET_WINDOW_TITLE) {
      isGameOpened = true;
    } else if (newTitle === APP_WINDOW_TITLE) {
      if (isGameOpened) {
      } else {
        isGameOpened = false;
      }
    }

    // Update currentFocusTitle
    if (newTitle !== currentFocusTitle) {
      oldFocusTitle = currentFocusTitle;
    }
    currentFocusTitle = newTitle;

    // if (newTitle !== oldFocusTitle) {
    //   console.log("Window check:", {
    //     old: oldFocusTitle,
    //     current: currentFocusTitle,
    //     target: TARGET_WINDOW_TITLE,
    //   });
    // }

    if (!mainWindow.isVisible()) {
      if (
        currentFocusTitle !== TARGET_WINDOW_TITLE &&
        oldFocusTitle !== APP_WINDOW_TITLE
      ) {
        isGameOpened = false;
      }
    }
  }, 200);

  // Hotkey registration
  const f5Registered = globalShortcut.register("F5", handleF5);
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
  console.log("F5 hotkey registered:", f5Registered, Date.now());
  if (!f5Registered) console.error("Failed to register F5 hotkey");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// IPC Handlers ==================================================

ipcMain.on("open-directory-dialog", (event) => {
  dialog
    .showOpenDialog({
      properties: ["openDirectory"],
    })
    .then((result) => {
      if (!result.canceled) {
        event.sender.send("selected-directory", result.filePaths[0]);
      }
    })
    .catch((err) => {
      console.error("Error opening directory dialog:", err);
    });
});

ipcMain.on("open-file-dialog", (event, field) => {
  const filters =
    field === "change-icon"
      ? [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }]
      : [{ name: "Executables", extensions: ["exe"] }];
  dialog
    .showOpenDialog({
      properties: ["openFile"],
      filters,
    })
    .then((result) => {
      if (!result.canceled) {
        event.sender.send("selected-file", result.filePaths[0], field);
      }
    })
    .catch((err) => {
      console.error("Error opening file dialog:", err);
    });
});

ipcMain.on("launch-executable", (event, exePath) => {
  if (path.resolve(exePath) === path.resolve(process.execPath)) {
    event.sender.send("launch-error", "Cannot launch the app itself!");
    return;
  }

  if (runningProcesses.has(exePath)) return;

  const workingDir = path.dirname(exePath);
  const child = exec(
    `"${exePath}"`,
    { cwd: workingDir, windowsHide: true, shell: true },
    (error) => {
      if (error) {
        event.sender.send("launch-error", error.message);
      } else {
        event.sender.send("launch-success", exePath);
      }
      runningProcesses.delete(exePath);
    }
  );

  runningProcesses.set(exePath, child);
  child.on("exit", () => runningProcesses.delete(exePath));
});

ipcMain.on("update-config", async (event, updatedConfig) => {
  try {
    const currentConfigData = await fs.readFile(configPath, "utf8");
    const currentConfig = JSON.parse(currentConfigData);
    const newConfig = { ...currentConfig, ...updatedConfig };
    await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2));
    console.log(`Updated config at ${configPath}:`, newConfig);
  } catch (err) {
    console.error("Failed to update config:", err);
  }
});

ipcMain.on("prompt-rename", (event, data) => {
  console.log("Received prompt-rename:", data);
  mainWindow.webContents.send("show-rename-dialog", data);
});

ipcMain.on("rename-mod", async (event, { modFolderPath, oldName, newName }) => {
  const newFolderPath = path.join(modFolderPath, "../", newName);
  try {
    await fs.rename(modFolderPath, newFolderPath);
    console.log(`Renamed mod from ${oldName} to ${newName}`);
    event.sender.send("context-menu-action", "rename", { success: true });
  } catch (err) {
    console.error("Error renaming mod:", err);
    event.sender.send("context-menu-action", "rename", {
      success: false,
      error: err.message,
    });
  }
});

ipcMain.on("confirm-delete", (event, data) => {
  console.log("Received confirm-delete:", data);
  mainWindow.webContents.send("show-delete-dialog", data);
});

ipcMain.on("delete-mod", async (event, { modFolderPath }) => {
  try {
    await fs.rm(modFolderPath, { recursive: true, force: true });
    console.log(`Deleted mod at ${modFolderPath}`);
    event.sender.send("context-menu-action", "delete", { success: true });
  } catch (err) {
    console.error("Error deleting mod:", err);
    event.sender.send("context-menu-action", "delete", {
      success: false,
      error: err.message,
    });
  }
});

ipcMain.on("prompt-move", (event, data) => {
  console.log("Received prompt-move:", data);
  mainWindow.webContents.send("show-move-dialog", data);
});

ipcMain.on(
  "move-mod",
  async (event, { modFolderPath, folderName, newCharacterName }) => {
    try {
      const configData = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(configData);
      const modRoot = config.mod_dir;

      let newModDirPath;
      if (newCharacterName.toLowerCase() === "others") {
        newModDirPath = path.join(modRoot, "others");
      } else if (
        newCharacterName.toLowerCase() === "gliders" ||
        newCharacterName.toLowerCase() === "weapons"
      ) {
        newModDirPath = path.join(modRoot, newCharacterName.toLowerCase());
      } else {
        newModDirPath = path.join(
          modRoot,
          "character",
          newCharacterName.toLowerCase().replaceAll(" ", "_")
        );
      }

      await fs.mkdir(newModDirPath, { recursive: true });
      const newFolderPath = path.join(newModDirPath, folderName);
      await fs.rename(modFolderPath, newFolderPath);
      console.log(`Moved mod ${folderName} to ${newCharacterName}`);
      event.sender.send("context-menu-action", "move", { success: true });
    } catch (err) {
      console.error("Error moving mod:", err);
      event.sender.send("context-menu-action", "move", {
        success: false,
        error: err.message,
      });
    }
  }
);

ipcMain.on("open-add-mod-dialog", (event, characterName) => {
  dialog
    .showOpenDialog({
      properties: ["openDirectory", "openFile"],
      filters: [
        { name: "Archive Files", extensions: ["zip", "rar"] },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    .then((result) => {
      if (!result.canceled && result.filePaths.length > 0) {
        event.sender.send(
          "selected-add-mod",
          result.filePaths[0],
          characterName
        );
      }
    })
    .catch((err) => {
      console.error("Error opening add mod dialog:", err);
    });
});

// DONE
