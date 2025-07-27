const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { ipcRenderer } = require("electron");
const { app } = require("@electron/remote");
const chokidar = require("chokidar");
const JSZip = require("jszip");
const unrar = require("node-unrar-js");

// global state object
const state = {
  modRoot: null,
  xxmiExe: null,
  gameExe: null,
  autoRefreshEnabled: true,
  currentTheme: "light",
  oldTheme: "light",
  customThemeStyles: "",
  isCustomThemeEnabled: false,
  enabledMods: new Map(),
  currentModData: null,
  isPackaged: app.isPackaged,
  basePath: app.isPackaged ? process.resourcesPath : app.getAppPath(),
  iconDir: path.join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    "src",
    "icons",
    "character-icon"
  ),
  resizeSettings: {
    character: { width: 150, height: 140 },
    mod: { width: 400, height: 300 },
  },
};

// default custom theme with explicit colors
const defaultCustomThemeStyles = `
  --background-color: #ccffcc;
  --primary-color: #ccffcc;
  --title-color: #2f4f2f;
  --accent-color: rgba(55, 65, 81, 0.7);
  --card-background: rgba(55, 65, 81, 0.7);
  --primary-text-color: #ffffff;
  --secondary-text-color: #2f4f2f;
  --scrollbar-color: #2f4f2f;
  --mod-enabled-color: yellow;
  --mod-error-color: red;
  --drag-drop-color: #00ff00;
  --font-family: "Annie Use Your Telescope", cursive;
  --mod-count-color: white;
  --header-buttons-color: rgba(55, 65, 81, 0.7);
  --header-button-text-color: white;
  --box-shadow: rgba(0, 0, 0, 0.5);
`.trim();

// character data
const characters = [
  { name: "Aalto", element: "aero" },
  { name: "Baizhi", element: "glacio" },
  { name: "Brant", element: "fusion" },
  { name: "Cantarella", element: "havoc" },
  { name: "Calcharo", element: "electro" },
  { name: "Camellya", element: "havoc" },
  { name: "Carlotta", element: "glacio" },
  { name: "Changli", element: "fusion" },
  { name: "Chixia", element: "fusion" },
  { name: "Danjin", element: "havoc" },
  { name: "Encore", element: "fusion" },
  { name: "Jianxin", element: "aero" },
  { name: "Jinhsi", element: "spectro" },
  { name: "Jiyan", element: "aero" },
  { name: "Lingyang", element: "glacio" },
  { name: "Lumi", element: "electro" },
  { name: "Mortefi", element: "fusion" },
  { name: "Phoebe", element: "spectro" },
  { name: "Roccia", element: "havoc" },
  { name: "Rover Female", element: ["havoc", "spectro", "aero"] },
  { name: "Rover Male", element: ["havoc", "spectro", "aero"] },
  { name: "Sanhua", element: "glacio" },
  { name: "Shorekeeper", element: "spectro" },
  { name: "Taoqi", element: "havoc" },
  { name: "Verina", element: "spectro" },
  { name: "Xiangliyao", element: "electro" },
  { name: "Yangyang", element: "aero" },
  { name: "Yinlin", element: "electro" },
  { name: "Youhu", element: "glacio" },
  { name: "Yuanwu", element: "electro" },
  { name: "Zani", element: "spectro" },
  { name: "Zhezhi", element: "glacio" },
  { name: "Others" },
  { name: "Weapons" },
  { name: "Gliders" },
];

const SLIDER_CONFIG = {
  character: {
    width: { min: 130, max: 190, step: 20, default: 150 },
    height: { min: 120, max: 200, step: 20, default: 140 },
  },
  mod: {
    width: { min: 260, max: 500, step: 80, default: 400 },
    height: { min: 250, max: 450, step: 40, default: 300 },
  },
};

const root = document.documentElement;

state.blurStates = new Map();

// cache
const caches = {
  modCounts: new Map(),
  icons: new Map(),
};

// utility Functions
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const showAlert = (message) => {
  const alert = document.getElementById("custom-alert");
  document.getElementById("alert-message").textContent = message;
  alert.style.display = "block";
};

const closeAlert = () => {
  document.getElementById("custom-alert").style.display = "none";
};

const gcd = (a, b) => (!b ? a : gcd(b, a % b));

const aspectRatio = (image) => {
  const { width, height } = image;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
};

// sile sys operation
const getModDirPath = (characterName) => {
  if (characterName === "Others") return path.join(state.modRoot, "others");
  if (["Gliders", "Weapons"].includes(characterName))
    return path.join(state.modRoot, characterName.toLowerCase());
  return path.join(
    state.modRoot,
    "character",
    characterName.toLowerCase().replaceAll(" ", "_")
  );
};

const toggleModFolder = async (characterName, folderName) => {
  const modDir = getModDirPath(characterName);
  const folderPath = path.join(modDir, folderName);
  const newFolderName = folderName.startsWith("DISABLED_")
    ? folderName.replace("DISABLED_", "")
    : `DISABLED_${folderName}`;
  const newFolderPath = path.join(modDir, newFolderName);

  const maxRetries = 5;
  const delay = 500;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rename(folderPath, newFolderPath);
      caches.modCounts.delete(characterName);
      return newFolderName;
    } catch (err) {
      if (err.code === "EPERM" && i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (err.code === "EPERM") {
        fsSync.renameSync(folderPath, newFolderPath);
        caches.modCounts.delete(characterName);
        return newFolderName;
      }
      throw err;
    }
  }
};

const copyFolder = async (source, destination) => {
  await fs.mkdir(destination, { recursive: true });
  const files = await fs.readdir(source, { withFileTypes: true });
  await Promise.all(
    files.map(async (file) => {
      const srcPath = path.join(source, file.name);
      const destPath = path.join(destination, file.name);
      return file.isDirectory()
        ? copyFolder(srcPath, destPath)
        : fs.copyFile(srcPath, destPath);
    })
  );
};

const extractAndCopyRar = async (rarPath, destination) => {
  const buf = Uint8Array.from(await fs.readFile(rarPath)).buffer;
  const extractor = await unrar.createExtractorFromData({ data: buf });
  const { files } = extractor.extract();
  await fs.mkdir(destination, { recursive: true });

  await Promise.all(
    Array.from(files).map(async (file) => {
      if (!file.fileHeader.flags.directory) {
        const filePath = path.join(destination, file.fileHeader.name);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.extract.content);
      }
    })
  );
};

// mod handle
const handleAddMod = async (filePath, characterName) => {
  if (!filePath) return;

  const modDirPath = getModDirPath(characterName);
  await fs.mkdir(modDirPath, { recursive: true });
  const fileExt = path.extname(filePath).toLowerCase();
  const modName = path.basename(filePath, fileExt);
  const destPath = path.join(modDirPath, modName);

  try {
    if (fileExt === ".zip") {
      const zipData = await fs.readFile(filePath);
      const zip = await JSZip.loadAsync(zipData);
      const files = Object.keys(zip.files);

      await Promise.all(
        files.map(async (fileName) => {
          const file = zip.files[fileName];
          const destFilePath = path.join(destPath, fileName);
          if (file.dir) {
            await fs.mkdir(destFilePath, { recursive: true });
          } else {
            const content = await file.async("nodebuffer");
            await fs.mkdir(path.dirname(destFilePath), { recursive: true });
            await fs.writeFile(destFilePath, content);
          }
        })
      );
    } else if (fileExt === ".rar") {
      await extractAndCopyRar(filePath, destPath);
    } else {
      const stats = await fs.stat(filePath);
      if (!stats.isDirectory()) {
        showAlert("Please drop a folder, .zip, or .rar file");
        return;
      }
      await copyFolder(filePath, destPath);
    }

    caches.modCounts.delete(characterName);
    const character = characters.find((c) => c.name === characterName);
    if (character) renderCharacterMods(character);
  } catch (err) {
    showAlert(`Failed to add mod: ${err.message}`);
  }
};
const showAddModForm = () => {
  const modGrid = document.getElementById("mod-grid");
  const character = modGrid.dataset.characterData
    ? JSON.parse(modGrid.dataset.characterData)
    : null;
  if (!character) {
    showAlert("No character selected for adding a mod");
    return;
  }
  ipcRenderer.send("open-add-mod-dialog", character.name);
};

// render
const loadCharacterIcons = async () => {
  try {
    const files = await fs.readdir(state.iconDir);
    characters.forEach((character) => {
      const imgFile = files.find((file) =>
        file.toLowerCase().startsWith(character.name.toLowerCase())
      );
      character.img = imgFile ? path.join(state.iconDir, imgFile) : null;
      caches.icons.set(character.name, character.img);
    });
  } catch {
    characters.forEach((character) => {
      character.img = null;
      caches.icons.set(character.name, null);
    });
  }
};

const getModCounts = async (characterName) => {
  if (caches.modCounts.has(characterName))
    return caches.modCounts.get(characterName);

  const modDirPath = getModDirPath(characterName);
  try {
    const folders = await fs.readdir(modDirPath, { withFileTypes: true });
    const modFolders = folders
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const enabledCount = modFolders.filter(
      (f) => !f.startsWith("DISABLED_")
    ).length;
    const result = { total: modFolders.length, enabled: enabledCount };
    caches.modCounts.set(characterName, result);
    return result;
  } catch {
    const result = { total: 0, enabled: 0 };
    caches.modCounts.set(characterName, result);
    return result;
  }
};
/*








*/

const showResizeContextMenu = (event) => {
  const resizeMenu = document.getElementById("resize-context-menu");
  const isCharacterGrid =
    document.getElementById("character-grid").style.display === "grid";
  const context = isCharacterGrid ? "character" : "mod";
  const config = SLIDER_CONFIG[context];
  const currentSettings = state.resizeSettings[context];

  // position menu centered horizontally relative to click
  const menuWidth = 250;
  resizeMenu.style.top = `${event.clientY}px`;
  resizeMenu.style.left = `${Math.max(0, event.clientX - (menuWidth + 25))}px`;
  resizeMenu.style.display = "block";

  // cache DOM element
  const widthSlider = document.getElementById("widthSlider");
  const heightSlider = document.getElementById("heightSlider");
  const widthValue = document.getElementById("widthValue");
  const heightValue = document.getElementById("heightValue");

  // slider attri
  Object.assign(widthSlider, {
    min: config.width.min,
    max: config.width.max,
    step: config.width.step,
    value: currentSettings.width,
  });
  Object.assign(heightSlider, {
    min: config.height.min,
    max: config.height.max,
    step: config.height.step,
    value: currentSettings.height,
  });

  widthValue.textContent = currentSettings.width;
  heightValue.textContent = currentSettings.height;

  applyContextMenuTheme(resizeMenu);

  // debounce update function
  const updateSize = debounce((dimension, value) => {
    const varName = `--${context}-card-${dimension}`;
    root.style.setProperty(varName, `${value}px`);
    state.resizeSettings[context][dimension] = value;
    ipcRenderer.send("update-config", { resizeSettings: state.resizeSettings });
  }, 50);

  const handleInput = (e) => {
    const slider = e.target;
    const dimension = slider.id === "widthSlider" ? "width" : "height";
    const value = slider.value;
    (dimension === "width" ? widthValue : heightValue).textContent = value;
    updateSize(dimension, value);
  };

  widthSlider.oninput = handleInput;
  heightSlider.oninput = handleInput;

  // cleanup and hide menu
  const hideMenu = (e) => {
    if (
      !resizeMenu.contains(e.target) &&
      e.target !== document.getElementById("view")
    ) {
      resizeMenu.style.display = "none";
      widthSlider.oninput = null;
      heightSlider.oninput = null;
      document.removeEventListener("click", hideMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", hideMenu), 0);
};

// initialize function remains largely the same but ensure initial CSS vars
async function initializeResizeContextMenu() {
  const button = document.getElementById("view");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    showResizeContextMenu(event);
  });

  // initial css
  root.style.setProperty(
    "--character-card-width",
    `${state.resizeSettings.character.width}px`
  );
  root.style.setProperty(
    "--character-card-height",
    `${state.resizeSettings.character.height}px`
  );
  root.style.setProperty(
    "--mod-card-width",
    `${state.resizeSettings.mod.width}px`
  );
  root.style.setProperty(
    "--mod-card-height",
    `${state.resizeSettings.mod.height}px`
  );
}

/*









*/
// render card
const renderIcons = async (
  searchQuery = "",
  elementFilter = null,
  character = null
) => {
  const characterGrid = document.getElementById("character-grid");
  const modGrid = document.getElementById("mod-grid");
  const mainContainer = document.getElementById("main-container");
  const headerTitle = document.querySelector(".header:nth-child(1) h1");
  const modGridIcon = document.querySelector(".mod-grid-icon");

  if (!characterGrid || !modGrid || !mainContainer) return;

  characterGrid.style.display = "grid";
  modGrid.style.display = "none";
  headerTitle.textContent = character
    ? `Character Overview: ${character.name}`
    : "Character Overview";
  mainContainer.classList.remove("drag-over");
  if (modGridIcon) modGridIcon.style.display = "none";

  const controls1 = document.querySelector(".header:nth-child(1) .controls");
  controls1.style.display = "flex";

  characterGrid.innerHTML = "";
  await loadCharacterIcons();
  const fragment = document.createDocumentFragment();
  const query = searchQuery.toLowerCase();

  let filteredCharacters = characters.filter((c) =>
    c.name.toLowerCase().includes(query)
  );
  if (elementFilter) {
    filteredCharacters = filteredCharacters.filter((c) => {
      if (!c.element) return false;
      return Array.isArray(c.element)
        ? c.element.includes(elementFilter)
        : c.element === elementFilter;
    });
  }

  for (const [index, char] of filteredCharacters.entries()) {
    const { total, enabled } = await getModCounts(char.name);
    const hasMultipleModsEnabled = enabled > 1;

    const modCountText =
      total && enabled ? `${enabled}/${total}` : total ? `${total}` : " ";
    const card = document.createElement("div");
    card.className = `character-card${
      hasMultipleModsEnabled &&
      char.name !== "Others" &&
      char.name !== "Weapons"
        ? " multiple-mods-warning"
        : enabled
        ? " enabled"
        : ""
    }${index === filteredCharacters.length - 1 ? " last-card" : ""}`;
    card.innerHTML = `
      <div class="character-image">
        ${
          char.img
            ? `<img src="${char.img}" alt="Character ${char.name}"/>`
            : `<div class="placeholder-image">${char.name}</div>`
        }
      </div>
      <span class="mod-count">${modCountText}</span>
      <span class="character-name">${char.name}</span>
    `;
    card.addEventListener("click", () => renderCharacterMods(char));

    fragment.appendChild(card);
  }

  characterGrid.appendChild(fragment);
  applyTheme(state.currentTheme);

  const cards = characterGrid.querySelectorAll(".character-card");
  cards.forEach((card, index) => {
    setTimeout(() => card.classList.add("visible"), index * 50);
  });

  const backButton = document.querySelector(
    ".header:nth-child(2) .controls:nth-child(1) .back-button"
  );
  if (backButton) backButton.style.display = "none";

  const controlsDivRight = document.querySelector(
    ".header:nth-child(2) .controls:nth-child(2)"
  );
  if (controlsDivRight) {
    ["button:nth-child(4)", "button:nth-child(5)", "input"].forEach(
      (selector) => {
        const el = controlsDivRight.querySelector(selector);
        if (el) el.style.display = "inline-block";
      }
    );
  }
};

const renderCharacterMods = async (character) => {
  const characterGrid = document.getElementById("character-grid");
  const modGrid = document.getElementById("mod-grid");
  const mainContainer = document.getElementById("main-container");
  const headerTitle = document.querySelector(".header:nth-child(1) h1");
  let modGridIcon = document.querySelector(".mod-grid-icon");

  if (!characterGrid || !modGrid || !mainContainer) return;

  const controls1 = document.querySelector(".header:nth-child(1) .controls");
  controls1.style.display = "none";

  characterGrid.style.display = "none";
  modGrid.style.display = "grid";
  modGrid.dataset.characterData = JSON.stringify(character);
  headerTitle.textContent = `Character Overview: ${character.name}`;

  if (!modGridIcon) {
    modGridIcon = document.createElement("div");
    modGridIcon.className = "mod-grid-icon";
    document.querySelector(".header:nth-child(1)").appendChild(modGridIcon);
  }
  modGridIcon.innerHTML = character.img
    ? `<img src="${character.img}" alt="Character ${character.name}">`
    : `<div class="placeholder-image">${character.name}</div>`;
  modGridIcon.style.display = "inline-block";

  characterGrid.innerHTML = "";
  modGrid.innerHTML = "";

  let dragCounter = 0;
  mainContainer.ondragenter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      characterGrid.style.display === "block" ||
      characterGrid.style.display === "none"
    ) {
      dragCounter++;
      mainContainer.classList.add("drag-over");
    }
  };
  mainContainer.ondragleave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (modGrid.style.display === "grid" || modGrid.style.display === "none") {
      dragCounter--;
      if (dragCounter === 0) mainContainer.classList.remove("drag-over");
    }
  };
  mainContainer.ondragover = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (modGrid.style.display !== "grid") e.dataTransfer.dropEffect = "none";
  };
  mainContainer.ondrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (modGrid.style.display === "grid" || modGrid.style.display === "none") {
      dragCounter = 0;
      mainContainer.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files.length > 0) handleAddMod(files[0].path, character.name);
    }
  };

  const controlsDivLeft = document.querySelector(
    ".header:nth-child(2) .controls:nth-child(1)"
  );
  let backButton = controlsDivLeft.querySelector(".back-button");
  if (!backButton) {
    backButton = document.createElement("button");
    backButton.className = "back-button";
    backButton.innerHTML = `<img src="${path.join(
      state.basePath,
      "src",
      "icons",
      "back.svg"
    )}" alt="Back">`;
    backButton.addEventListener("click", () => {
      const addMod = document.getElementById("add-mod");
      if (addMod) addMod.style.display = "none";
      mainContainer.classList.remove("drag-over");
      renderIcons();
    });
    controlsDivLeft.appendChild(backButton);
  }
  backButton.style.display = "inline-block";
  backButton.classList.add("visible");

  const controlsDivRight = document.querySelector(
    ".header:nth-child(2) .controls:nth-child(2)"
  );
  if (controlsDivRight) {
    ["button:nth-child(4)", "button:nth-child(5)", "input"].forEach(
      (selector) => {
        const el = controlsDivRight.querySelector(selector);
        if (el) el.style.display = "none";
      }
    );
    const addMod = document.getElementById("add-mod");
    if (addMod) addMod.style.display = "inline-block";
  }

  const modDirPath = getModDirPath(character.name);
  try {
    await fs.access(modDirPath);
    const folders = await fs.readdir(modDirPath, { withFileTypes: true });
    const modFolders = folders
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const enabledSet = new Set(
      modFolders.filter((f) => !f.startsWith("DISABLED_"))
    );
    state.enabledMods.set(
      character.name,
      enabledSet.size > 0
        ? enabledSet
        : state.enabledMods.delete(character.name)
    );

    const sortedModFolders = modFolders.sort((a, b) =>
      enabledSet.has(a) === enabledSet.has(b) ? 0 : enabledSet.has(a) ? -1 : 1
    );
    const fragment = document.createDocumentFragment();

    for (const [index, folderName] of sortedModFolders.entries()) {
      const modCard = document.createElement("div");
      modCard.className = `mod-card${
        index === sortedModFolders.length - 1 ? " last-card" : ""
      }`;
      const isEnabled = !folderName.startsWith("DISABLED_");
      const modFolderPath = path.join(modDirPath, folderName);

      let previewImage = "";
      try {
        const wsmmCoverPath = path.join(modFolderPath, ".WSMM_Cover.png");
        await fs.access(wsmmCoverPath);
        previewImage = `${wsmmCoverPath}?t=${Date.now()}`;
      } catch {
        try {
          const whatImagePath = path.join(state.iconDir, "what.png");
          await fs.access(whatImagePath);
          previewImage = `${whatImagePath}?t=${Date.now()}`;
        } catch {
          previewImage = "";
        }
      }

      // blur nsfw card
      const configPath = path.join(modFolderPath, ".WSMM_Config.json");
      let isBlurred = false;
      try {
        const configData = await fs.readFile(configPath, "utf8");
        const config = JSON.parse(configData);
        isBlurred = config.blurState || false;
      } catch (err) {
        isBlurred = false;
      }

      modCard.innerHTML = `
        <div class="mod-image">
          ${
            previewImage
              ? `
                <div class="image-container">
                  <img src="${previewImage}" alt="Mod ${folderName}" style="filter: ${
                  isBlurred ? "blur(5px)" : "none"
                }"/>
                  <button class="blur-toggle" aria-label="Toggle blur">
                    <i class="fa fa-eye${isBlurred ? "-slash" : ""}"></i>
                  </button>
                </div>`
              : `<div class="placeholder-image">No Preview</div>`
          }
        </div>
        <label class="switch">
          <input type="checkbox" class="mod-toggle" id="${folderName}-toggle" ${
        isEnabled ? "checked" : ""
      }>
          <span class="slider"></span>
        </label>
        <span class="mod-name">${folderName.replace("DISABLED_", "")}</span>
      `;

      if (previewImage) {
        const img = modCard.querySelector(".mod-image img");
        const imageObj = new Image();
        imageObj.src = previewImage;
        imageObj.onload = () => {
          img.style.objectFit =
            aspectRatio(imageObj) === "16:9" ? "cover" : "contain";
        };
      }

      if (isEnabled) modCard.classList.add("enabled");

      modCard
        .querySelector(".mod-image")
        .addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showCustomContextMenu(e, {
            modFolderPath,
            folderName,
            characterName: character.name,
          });
        });

      // blur toggle
      if (previewImage) {
        const blurToggle = modCard.querySelector(".blur-toggle");
        const img = modCard.querySelector(".mod-image img");

        blurToggle.addEventListener("click", async (e) => {
          e.stopPropagation();
          isBlurred = !isBlurred;
          img.style.filter = isBlurred ? "blur(12px)" : "none";
          blurToggle.innerHTML = `<i class="fa fa-eye${
            isBlurred ? "-slash" : ""
          }"></i>`;

          // szve blur state in confifg
          const config = { blurState: isBlurred };
          try {
            await fs.writeFile(
              configPath,
              JSON.stringify(config, null, 2),
              "utf8"
            );
          } catch (err) {
            console.error(`Failed to save blur state for ${folderName}:`, err);
          }
        });
      }

      const checkbox = modCard.querySelector(".mod-toggle");
      checkbox.addEventListener("change", async (e) => {
        const allowMultiple =
          character.name === "Others" || character.name === "Weapons";
        if (e.target.checked) {
          if (!allowMultiple) {
            for (const otherFolder of modFolders) {
              if (
                otherFolder !== folderName &&
                !otherFolder.startsWith("DISABLED_")
              ) {
                await toggleModFolder(character.name, otherFolder);
              }
            }
          }
          const newFolderName = await toggleModFolder(
            character.name,
            folderName
          );
          enabledSet.delete(folderName);
          enabledSet.add(newFolderName);
          modCard.classList.add("enabled");
        } else {
          const newFolderName = await toggleModFolder(
            character.name,
            folderName
          );
          enabledSet.delete(folderName);
          enabledSet.add(newFolderName);
          modCard.classList.remove("enabled");
        }
        state.enabledMods.set(
          character.name,
          enabledSet.size > 0
            ? enabledSet
            : state.enabledMods.delete(character.name)
        );
        renderCharacterMods(character);
      });

      fragment.appendChild(modCard);
    }

    if (modFolders.length === 0) {
      characterGrid.style.display = "block";
      modGrid.style.display = "none";
      characterGrid.innerHTML = `<span class="mod-error">No mods found for ${character.name}</span>`;
    }

    modGrid.appendChild(fragment);
    applyTheme(state.currentTheme);

    const modCards = modGrid.querySelectorAll(".mod-card");
    modCards.forEach((card, index) => {
      setTimeout(() => card.classList.add("visible"), index * 100);
    });
  } catch (err) {
    characterGrid.style.display = "block";
    modGrid.style.display = "none";
    characterGrid.innerHTML =
      err.code === "ENOENT"
        ? `<span class="mod-error">No mods found for ${character.name}</span>`
        : `<span class="mod-error">Error loading mods for ${character.name}</span>`;
    applyTheme(state.currentTheme);
  }
};

const refreshMod = async () => {
  const modGrid = document.getElementById("mod-grid");
  if (modGrid.dataset.characterData) {
    const character = JSON.parse(modGrid.dataset.characterData);
    modGrid.style.display === "grid"
      ? renderCharacterMods(character)
      : renderIcons("", null, character);
  } else {
    renderIcons();
  }
};

// custom theme func
const parseCustomTheme = (cssString) => {
  const theme = {};
  cssString.split("\n").forEach((line) => {
    const trimmedLine = line.trim();
    if (
      trimmedLine &&
      trimmedLine.startsWith("--") &&
      trimmedLine.includes(":")
    ) {
      const [key, value] = trimmedLine.split(":").map((part) => part.trim());
      if (key && value && value.endsWith(";")) {
        theme[key.slice(2)] = value.slice(0, -1);
      }
    }
  });
  return theme;
};

const applyTheme = (theme) => {
  const styleElement =
    document.getElementById("custom-theme-style") ||
    document.createElement("style");

  styleElement.id = "custom-theme-style";
  if (!document.head.contains(styleElement))
    document.head.appendChild(styleElement);

  if (theme === "dark") {
    root.style.setProperty("--background-color", "#333");
    root.style.setProperty("--primary-color", "#333");
    root.style.setProperty("--title-color", "white");
    root.style.setProperty("--accent-color", "#444");
    root.style.setProperty("--card-background", "#555");
    root.style.setProperty("--primary-text-color", "white");
    root.style.setProperty("--secondary-text-color", "white");
    root.style.setProperty("--scrollbar-color", "#fff");
    root.style.setProperty("--box-shadow", "rgba(255, 255, 255, 0.5)");
    root.style.setProperty("--header-buttons-color", "rgba(0, 0, 0, 0.5)");

    //inside settings
    [".select-selected", ".select-items"].forEach((selector) => {
      const el = document.querySelector(selector);
      el.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
      el.style.color = "black";
    });

    styleElement.textContent = `.dialog-buttons button:hover{background:rgba(255,255,255,0.4);}.select-items div:hover{color:white;}`;
  } else if (theme === "light" || !theme) {
    root.style.setProperty("--background-color", "#ccffcc");
    root.style.setProperty("--primary-color", "#ccffcc");
    root.style.setProperty("--title-color", "#2f4f2f");
    root.style.setProperty("--accent-color", "rgba(55, 65, 81, 0.7)");
    root.style.setProperty("--card-background", "rgba(55, 65, 81, 0.7)");
    root.style.setProperty("--primary-text-color", "#ffffff");
    root.style.setProperty("--secondary-text-color", "#2f4f2f");
    root.style.setProperty("--scrollbar-color", "#2f4f2f");
    root.style.setProperty("--box-shadow", "rgba(0, 0, 0, 0.5)");
    root.style.setProperty("--header-buttons-color", "rgba(55, 65, 81, 0.7)");

    //inside settings
    [".select-selected", ".select-items"].forEach((selector) => {
      const el = document.querySelector(selector);
      el.style.backgroundColor = "#ccffcc";
      el.style.color = "black";
    });

    styleElement.textContent = `.dialog-buttons button:hover{background:rgba(255,255,255,0.4);}.select-items div:hover{color:white;}`;
  } else if (theme === "custom" && state.isCustomThemeEnabled) {
    applyCustomTheme();
  }
};

const applyCustomTheme = () => {
  const theme = parseCustomTheme(state.customThemeStyles);
  const defaults = {
    "background-color": "#ccffcc",
    "primary-color": "#ccffcc",
    "title-color": "#2f4f2f",
    "accent-color": "rgba(55, 65, 81, 0.7)",
    "card-background": "rgba(55, 65, 81, 0.7)",
    "primary-text-color": "#ffffff",
    "secondary-text-color": "#2f4f2f",
    "scrollbar-color": "#2f4f2f",
    "mod-enabled-color": "yellow",
    "mod-error-color": "red",
    "drag-drop-color": "#00ff00",
    "font-family": '"Annie Use Your Telescope", cursive',
    "mod-count-color": "#fff",
    "header-buttons-color": "rgba(55, 65, 81, 0.7)",
    "header-button-text-color": "#fff",
    "box-shadow": "rgba(0, 0, 0, 0.5)",
  };

  const properties = Object.keys(defaults);

  properties.forEach((prop) => {
    root.style.setProperty(`--${prop}`, theme[prop] || defaults[prop]);
  });

  // custom font loading
  if (theme["font-family"]) {
    const fontName = theme["font-family"]
      .split(",")[0]
      .trim()
      .replace(/['"]/g, "");
    if (fontName && fontName !== "Annie Use Your Telescope") {
      loadWebFont(fontName);
    }
  }

  // inside settings
  [".select-selected", ".select-items"].forEach((selector) => {
    const el = document.querySelector(selector);
    if (el) {
      el.style.backgroundColor = "rgba(55, 65, 81, 0.7)";
      el.style.color = "white";
      el.style.fontFamily = "var(--font-family)";
    }
  });
};

const loadWebFont = (fontName) => {
  const existingFont = document.querySelector(`link[data-font="${fontName}"]`);
  if (existingFont) return;

  const fontLink = document.createElement("link");
  fontLink.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    fontName
  )}&display=swap`;
  fontLink.rel = "stylesheet";
  fontLink.dataset.font = fontName;
  fontLink.onerror = () => {
    console.warn(`Failed to load font: ${fontName}`);
    showAlert(`Font "${fontName}" could not be loaded. Using default font.`);
  };
  document.head.appendChild(fontLink);
};

// cntx menu func
const showCustomContextMenu = (event, data) => {
  state.currentModData = data;
  const contextMenu = document.getElementById("custom-context-menu");
  contextMenu.style.top = `${event.y}px`;
  contextMenu.style.left = `${event.x}px`;
  contextMenu.style.display = "block";

  applyContextMenuTheme(contextMenu);

  const menuItems = contextMenu.querySelectorAll(".context-menu-item");
  menuItems.forEach((item) => {
    item.replaceWith(item.cloneNode(true));
  });
  contextMenu.querySelectorAll(".context-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      handleContextMenuAction(item.getAttribute("data-action"), data);
      contextMenu.style.display = "none";
    });
  });

  const hideMenu = (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.style.display = "none";
      document.removeEventListener("click", hideMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", hideMenu), 0);
};

const handleContextMenuAction = (action, data) => {
  switch (action) {
    case "change-icon":
      ipcRenderer.send("open-file-dialog", "change-icon");
      break;
    case "rename":
      ipcRenderer.send("prompt-rename", data);
      break;
    case "delete":
      ipcRenderer.send("confirm-delete", data);
      break;
    case "move":
      ipcRenderer.send("prompt-move", data);
      break;
    default:
      console.log(`Unknown action: ${action}`);
  }
};

const applyContextMenuTheme = (menu) => {
  if (state.currentTheme === "dark") {
    menu.style.background = "#444";
    menu.querySelectorAll(".context-menu-item").forEach((item) => {
      item.style.color = "#ffffff";
      item.style.background = "";
      item.addEventListener(
        "mouseover",
        () => (item.style.background = "#555")
      );
      item.addEventListener("mouseout", () => (item.style.background = ""));
    });
  } else if (state.currentTheme === "light" || !state.currentTheme) {
    menu.style.background = "rgba(55, 65, 81, 0.7)";
    menu.querySelectorAll(".context-menu-item").forEach((item) => {
      item.style.color = "white";
      item.style.background = "";
      item.addEventListener(
        "mouseover",
        () => (item.style.background = "rgba(255, 255, 255, 0.1)")
      );
      item.addEventListener("mouseout", () => (item.style.background = ""));
    });
  } else if (state.currentTheme === "custom" && state.isCustomThemeEnabled) {
    const theme = parseCustomTheme(state.customThemeStyles);
    const defaults = {
      primaryTextColor: "#ffffff",
      accentColor: "rgba(55, 65, 81, 0.7)",
      contextMenuBackground: "rgba(55, 65, 81, 0.7)",
    };
    menu.style.background =
      theme.contextMenuBackground || defaults.contextMenuBackground;
    menu.querySelectorAll(".context-menu-item").forEach((item) => {
      item.style.color = theme.primaryTextColor || defaults.primaryTextColor;
      item.style.background = "";
      item.addEventListener(
        "mouseover",
        () =>
          (item.style.background = theme.accentColor || defaults.accentColor)
      );
      item.addEventListener("mouseout", () => (item.style.background = ""));
    });
  }
};

// IPC Event Handlers
ipcRenderer.on("config-loaded", (event, config) => {
  state.modRoot = config.mod_dir;
  state.xxmiExe = config.xxmi_exe;
  state.gameExe = config.game_exe;
  state.autoRefreshEnabled = config.auto_refresh_mods;
  state.currentTheme = config.theme || "light";
  state.oldTheme = config.theme || "light";
  state.isCustomThemeEnabled = config.is_custom_theme_enabled || false;
  state.customThemeStyles = config.custom_theme_css || defaultCustomThemeStyles;

  document.getElementById("custom-theme-input").value = state.customThemeStyles;
  document.getElementById("custom-theme-preview").textContent =
    state.customThemeStyles;
  hljs.highlightElement(document.getElementById("custom-theme-preview"));

  state.resizeSettings = config.resizeSettings || {
    character: {
      width: SLIDER_CONFIG.character.width.default,
      height: SLIDER_CONFIG.character.height.default,
    },
    mod: {
      width: SLIDER_CONFIG.mod.width.default,
      height: SLIDER_CONFIG.mod.height.default,
    },
  };

  initialize();
});

ipcRenderer.on("selected-directory", (event, dir) => {
  if (dir) {
    state.modRoot = dir;
    document.getElementById("mod-dir").value = dir;
    ipcRenderer.send("update-config", { mod_dir: dir });
    renderIcons();
  }
});

ipcRenderer.on("selected-file", (event, file, field) => {
  if (!file) return;
  if (field === "xxmi-dir") {
    state.xxmiExe = file;
    document.getElementById("xxmi-dir").value = file;
    ipcRenderer.send("update-config", { xxmi_exe: file });
  } else if (field === "game-dir") {
    state.gameExe = file;
    document.getElementById("game-dir").value = file;
    ipcRenderer.send("update-config", { game_exe: file });
  } else if (field === "change-icon") {
    const modGrid = document.getElementById("mod-grid");
    const character =
      modGrid && modGrid.dataset.characterData
        ? JSON.parse(modGrid.dataset.characterData)
        : null;
    if (character && state.currentModData) {
      const newIconPath = path.join(
        state.currentModData.modFolderPath,
        ".WSMM_Cover.png"
      );
      fs.copyFile(file, newIconPath)
        .then(() => {
          ipcRenderer.send("context-menu-action", "change-icon", {
            success: true,
          });
          renderCharacterMods(character);
        })
        .catch((err) => {
          ipcRenderer.send("context-menu-action", "change-icon", {
            success: false,
            error: err.message,
          });
        });
    }
  }
});

ipcRenderer.on("launch-error", (event, errorMessage) =>
  showAlert(`Failed to launch executable: ${errorMessage}`)
);

ipcRenderer.on("show-rename-dialog", (event, data) => {
  state.currentModData = data;
  const renameDialog = document.getElementById("rename-dialog");
  document.getElementById("rename-input").value = data.folderName.replace(
    "DISABLED_",
    ""
  );
  renameDialog.style.display = "block";
});

ipcRenderer.on("show-move-dialog", (event, data) => {
  state.currentModData = data;
  const moveDialog = document.getElementById("move-dialog");
  const moveSelect = document.getElementById("move-select");
  moveSelect.innerHTML = '<option value="">Select a character</option>';
  characters.forEach((char) => {
    if (char.name !== data.characterName) {
      const option = document.createElement("option");
      option.value = char.name;
      option.textContent = char.name;
      moveSelect.appendChild(option);
    }
  });
  moveDialog.style.display = "block";
});

ipcRenderer.on("show-delete-dialog", (event, data) => {
  state.currentModData = data;
  const deleteDialog = document.getElementById("delete-dialog");
  document.getElementById(
    "delete-message"
  ).textContent = `Are you sure you want to delete "${data.folderName.replace(
    "DISABLED_",
    ""
  )}"?`;
  deleteDialog.style.display = "block";
});

ipcRenderer.on("context-menu-action", (event, action, data) => {
  const modGrid = document.getElementById("mod-grid");
  const character =
    modGrid && modGrid.dataset.characterData
      ? JSON.parse(modGrid.dataset.characterData)
      : null;
  if (!character) return;

  switch (action) {
    case "change-icon":
      data.success
        ? renderCharacterMods(character)
        : showAlert(`Failed to change icon: ${data.error}`);
      break;
    case "rename":
      data.success
        ? renderCharacterMods(character)
        : showAlert(`Failed to rename mod: ${data.error}`);
      break;
    case "delete":
      data.success
        ? renderCharacterMods(character)
        : showAlert(`Failed to delete mod: ${data.error}`);
      break;
    case "move":
      data.success
        ? renderIcons()
        : showAlert(`Failed to move mod: ${data.error}`);
      break;
  }
});

// Initialization
const initialize = async () => {
  if (!state.modRoot)
    showAlert("Mod folder not set yet. Please configure it from settings");

  const watcher = chokidar.watch(path.join(state.modRoot, "*"), {
    persistent: true,
    ignoreInitial: false,
    depth: 1,
  });
  watcher.on(
    "all",
    debounce(() => {
      const mainContainer = document.getElementById("main-container");
      if (mainContainer.style.display !== "none" && state.autoRefreshEnabled)
        renderIcons();
    }, 100)
  );

  const mainContainer = document.getElementById("main-container");
  const settings = document.getElementById("settings");
  mainContainer.style.display = "block";
  settings.style.display = "none";
  document.getElementById("custom-context-menu").style.display = "none";

  const menuItems = document.querySelectorAll(".menu-item");
  const contentSections = document.querySelectorAll(".content-section");
  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      menuItems.forEach((i) => i.classList.remove("active"));
      contentSections.forEach((s) => s.classList.remove("active"));
      item.classList.add("active");
      document
        .getElementById(item.getAttribute("data-target"))
        .classList.add("active");
      setTimeout(() => applyTheme(state.currentTheme), 0);
    });
  });

  document.getElementById("mod-dir").value = state.modRoot || "";
  document
    .getElementById("browse-mod-dir")
    .addEventListener("click", () => ipcRenderer.send("open-directory-dialog"));
  document.getElementById("auto-refresh").checked = state.autoRefreshEnabled;
  document.getElementById("auto-refresh").addEventListener("change", (e) => {
    state.autoRefreshEnabled = e.target.checked;
    ipcRenderer.send("update-config", {
      auto_refresh_mods: state.autoRefreshEnabled,
    });
  });

  document.getElementById("xxmi-dir").value = state.xxmiExe || "";
  document
    .getElementById("xxmi-exe-dir")
    .addEventListener("click", () =>
      ipcRenderer.send("open-file-dialog", "xxmi-dir")
    );
  document.getElementById("game-dir").value = state.gameExe || "";
  document
    .getElementById("game-exe-dir")
    .addEventListener("click", () =>
      ipcRenderer.send("open-file-dialog", "game-dir")
    );
  document
    .getElementById("start-xxmi")
    .addEventListener("click", () =>
      state.xxmiExe
        ? ipcRenderer.send("launch-executable", state.xxmiExe)
        : showAlert("Please select the XXMI executable in settings.")
    );
  document
    .getElementById("start-game")
    .addEventListener("click", () =>
      state.gameExe
        ? ipcRenderer.send("launch-executable", state.gameExe)
        : showAlert("Please select the game executable in settings.")
    );

  const themeToggleSelected = document.getElementById("theme-toggle-selected");
  const themeOptionsContainer = document.getElementById("theme-options");
  const customThemeToggle = document.getElementById("custom-theme-toggle");
  const customThemeOptions = document.getElementById("custom-theme-options");
  const customThemeInput = document.getElementById("custom-theme-input");
  const customThemePreview = document.getElementById("custom-theme-preview");

  themeToggleSelected.textContent =
    state.currentTheme.charAt(0).toUpperCase() + state.currentTheme.slice(1);
  customThemeToggle.checked = state.isCustomThemeEnabled;
  customThemeOptions.style.display = state.isCustomThemeEnabled
    ? "flex"
    : "none";
  customThemeInput.value = state.customThemeStyles;
  customThemePreview.textContent = state.customThemeStyles;
  hljs.highlightElement(customThemePreview);

  themeToggleSelected.addEventListener("click", () =>
    document.querySelector(".select-items").classList.toggle("select-hide")
  );
  themeOptionsContainer.querySelectorAll("div").forEach((item) => {
    item.addEventListener("click", () => {
      state.oldTheme = state.currentTheme;
      state.currentTheme = item.getAttribute("data-value");
      themeToggleSelected.textContent = item.textContent;
      if (state.isCustomThemeEnabled) {
        state.isCustomThemeEnabled = false;
        customThemeToggle.checked = false;
        customThemeOptions.style.display = "none";
      }
      applyTheme(state.currentTheme);
      ipcRenderer.send("update-config", {
        theme: state.currentTheme,
        is_custom_theme_enabled: state.isCustomThemeEnabled,
      });
      document.querySelector(".select-items").classList.add("select-hide");
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".custom-select"))
      document.querySelector(".select-items").classList.add("select-hide");
  });

  customThemeToggle.addEventListener("change", (e) => {
    state.isCustomThemeEnabled = e.target.checked;
    customThemeOptions.style.display = state.isCustomThemeEnabled
      ? "flex"
      : "none";
    if (state.isCustomThemeEnabled) {
      state.oldTheme = state.currentTheme;
      state.currentTheme = "custom";
      themeToggleSelected.textContent = "Custom";
    } else {
      state.currentTheme = state.oldTheme || "light";
      themeToggleSelected.textContent =
        state.currentTheme === "light" ? "Light" : "Dark";
    }
    applyTheme(state.currentTheme);
    ipcRenderer.send("update-config", {
      is_custom_theme_enabled: state.isCustomThemeEnabled,
      theme: state.currentTheme,
    });
  });

  let saveTimeout;
  customThemeInput.addEventListener("input", (e) => {
    state.customThemeStyles = e.target.value;
    customThemePreview.textContent = state.customThemeStyles;
    hljs.highlightElement(customThemePreview);
    if (state.isCustomThemeEnabled) applyTheme("custom");
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(
      () =>
        ipcRenderer.send("update-config", {
          custom_theme_css: state.customThemeStyles,
        }),
      500
    );
  });

  customThemeInput.addEventListener("blur", () => {
    if (
      state.customThemeStyles.trim() &&
      state.customThemeStyles.trim() !== defaultCustomThemeStyles.trim()
    ) {
      ipcRenderer.send("update-config", {
        custom_theme_css: state.customThemeStyles,
      });
      if (state.isCustomThemeEnabled) applyTheme("custom");
    }
  });

  const controlsDivRight = document.querySelector(
    ".header:nth-child(2) .controls:nth-child(2)"
  );
  if (controlsDivRight && !document.getElementById("add-mod")) {
    const addMod = document.createElement("button");
    addMod.id = "add-mod";
    addMod.textContent = "Add Mod";
    addMod.style.display = "none";
    addMod.addEventListener("click", showAddModForm);
    controlsDivRight.appendChild(addMod);
  }

  document.getElementById("settings-btn").addEventListener("click", () => {
    mainContainer.style.display = "none";
    settings.style.display = "block";
    applyTheme(state.currentTheme);
  });

  document
    .getElementById("back-to-characters")
    .addEventListener("click", () => {
      mainContainer.style.display = "block";
      settings.style.display = "none";
      renderIcons();
    });

  const searchInput = document.querySelector(
    ".header:nth-child(2) .controls:nth-child(2) input"
  );
  if (searchInput)
    searchInput.addEventListener("input", (e) =>
      renderIcons(e.target.value.trim())
    );

  let currentElementFilter = null;
  document.querySelectorAll(".icon-buttons button").forEach((button) => {
    button.addEventListener("click", () => {
      const icon = button.querySelector("i");
      const iconClass = icon.classList;
      const elementMap = {
        "fa-fire": "fusion",
        "fa-sun": "spectro",
        "fa-bolt": "electro",
        "fa-wind": "aero",
        "fa-moon": "havoc",
        "fa-snowflake": "glacio",
      };
      const elementFilter = Object.keys(elementMap).find((key) =>
        iconClass.contains(key)
      )
        ? elementMap[
            Object.keys(elementMap).find((key) => iconClass.contains(key))
          ]
        : null;

      if (currentElementFilter === elementFilter) {
        currentElementFilter = null;
        button.style.outline = "";
      } else {
        document
          .querySelectorAll(".icon-buttons button")
          .forEach((btn) => (btn.style.outnline = ""));
        button.style.outline = "2px solid " + button.style.color;
        currentElementFilter = elementFilter;
      }
      renderIcons(
        searchInput ? searchInput.value.trim() : "",
        currentElementFilter
      );
    });
  });

  document.getElementById("rename-confirm").addEventListener("click", () => {
    const newName = document.getElementById("rename-input").value.trim();
    if (newName && state.currentModData) {
      ipcRenderer.send("rename-mod", {
        modFolderPath: state.currentModData.modFolderPath,
        oldName: state.currentModData.folderName,
        newName: state.currentModData.folderName.startsWith("DISABLED_")
          ? `DISABLED_${newName}`
          : newName,
      });
      document.getElementById("rename-dialog").style.display = "none";
    }
  });

  document
    .getElementById("rename-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("rename-dialog").style.display = "none")
    );

  document.getElementById("move-confirm").addEventListener("click", () => {
    const newCharacterName = document.getElementById("move-select").value;
    if (newCharacterName && state.currentModData) {
      ipcRenderer.send("move-mod", {
        modFolderPath: state.currentModData.modFolderPath,
        folderName: state.currentModData.folderName,
        newCharacterName,
      });
      document.getElementById("move-dialog").style.display = "none";
    }
  });

  document
    .getElementById("move-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("move-dialog").style.display = "none")
    );

  document.getElementById("delete-confirm").addEventListener("click", () => {
    if (state.currentModData) {
      ipcRenderer.send("delete-mod", {
        modFolderPath: state.currentModData.modFolderPath,
      });
      document.getElementById("delete-dialog").style.display = "none";
    }
  });

  document
    .getElementById("delete-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("delete-dialog").style.display = "none")
    );

  document.getElementById("close-alert").addEventListener("click", closeAlert);

  renderIcons();
  await initializeResizeContextMenu();
};

document.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.send("load-config");

  const dragArea = document.getElementById("drag-area");
  dragArea.addEventListener("mousedown", (e) => e.stopPropagation());
  dragArea.addEventListener("click", (e) => e.stopPropagation());
});

ipcRenderer.on("selected-add-mod", (event, filePath, characterName) =>
  handleAddMod(filePath, characterName)
);
