import {
  App,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { readdir, readFile } from "fs/promises";
import path from "path";
import {
  LECTURES_FOLDER_NAME,
  MODULES_FOLDER_PATH,
  OBSIDIAN_GOODNOTES_FOLDER_PATH,
} from "./main";

const ONEDRIVE_FOLDER_PATH =
  "/Users/arthur/Library/CloudStorage/OneDrive-Personal";

const GOODNOTES_MODULES_FOLDER_PATH = path.join(
  ONEDRIVE_FOLDER_PATH,
  "GoodNotes",
  "Uni",
  "Module"
);

const GOODNOTES_SECTION_HEADING = "## Goodnotes Material";
const GOODNOTES_NO_MATERIAL_TEXT = "No GoodNotes materials found.";
const ARCHIVED_SUFFIX = " (deleted)";
const SOURCE_READ_RETRIES = 5;
const SOURCE_READ_RETRY_DELAY_MS = 500;
const SOURCE_FILE_READ_RETRIES = 5;
let syncInProgress: Promise<void> | null = null;

function isArchivedName(name: string): boolean {
  return name.endsWith(ARCHIVED_SUFFIX) || name.startsWith("DELETED_");
}

function normalizeFileName(name: string): string {
  return name.normalize("NFC");
}

function isSyncableEntry(entry: import("fs").Dirent): boolean {
  return !entry.isSymbolicLink() && !entry.name.startsWith(".");
}

/**
 * Returns the leading YYYY-MM-DD filename prefix, or null when absent.
 * Examples:
 *   "2026-10-20 - Lecture.pdf" -> "2026-10-20"
 *   "2026-10-20.pdf"           -> "2026-10-20"
 *   "Lecture 2026-10-20.pdf"    -> null
 */
function getDatePrefix(filename: string): string | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})(?=$|[\s.-])/);
  return match?.[1] ?? null;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

async function readSourceDirectory(sourceDir: string): Promise<import("fs").Dirent[]> {
  let previousSignature: string | null = null;

  for (let attempt = 1; attempt <= SOURCE_READ_RETRIES; attempt++) {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    const signature = entries
      .filter(isSyncableEntry)
      .map(
        (entry) =>
          `${normalizeFileName(entry.name)}:${
            entry.isDirectory() ? "directory" : "file"
          }`
      )
      .sort()
      .join("\n");

    if (signature === previousSignature || attempt === SOURCE_READ_RETRIES) {
      return entries;
    }

    previousSignature = signature;
    await new Promise((resolve) =>
      window.setTimeout(resolve, SOURCE_READ_RETRY_DELAY_MS)
    );
  }

  throw new Error(`Could not read source directory: ${sourceDir}`);
}

/**
 * Renames a stale mirror item without overwriting another item.
 * The item is renamed through Obsidian so its internal links can be updated.
 */
async function archiveVaultItem(
  app: App,
  item: TAbstractFile
): Promise<void> {
  if (!(item instanceof TFile) && !(item instanceof TFolder)) {
    return;
  }

  if (isArchivedName(item.name)) {
    return;
  }

  const parentPath = item.parent?.path ?? "";
  const extension = item instanceof TFile ? `.${item.extension}` : "";
  const nameWithoutExtension = item instanceof TFile
    ? item.name.slice(0, -extension.length)
    : item.name;
  const baseName = `${nameWithoutExtension}${ARCHIVED_SUFFIX}${extension}`;
  let candidateName = baseName;
  let counter = 2;

  const makePath = (name: string) =>
    normalizePath(parentPath ? `${parentPath}/${name}` : name);

  while (app.vault.getAbstractFileByPath(makePath(candidateName))) {
    candidateName =
      `${nameWithoutExtension}${ARCHIVED_SUFFIX} ${counter}${extension}`;
    counter++;
  }

  await app.fileManager.renameFile(item, makePath(candidateName));
}

/**
 * Mirrors a source directory into an existing Obsidian folder.
 * New/changed files are copied; unchanged files are not rewritten.
 * Target items missing from the source are renamed with a "(deleted)" suffix.
 *
 * Items already suffixed with "(deleted)" are retained and never re-archived.
 */
async function mirrorFolderContents(
  app: App,
  sourceFolderPath: string,
  targetFolderPath: string
): Promise<void> {
  const sourceRoot = path.resolve(sourceFolderPath);
  const targetRoot = normalizePath(targetFolderPath);

  const targetRootFolder = app.vault.getFolderByPath(targetRoot);
  if (!targetRootFolder) {
    throw new Error(`Target folder does not exist: ${targetRoot}`);
  }

  async function mirrorDirectory(
    sourceDir: string,
    targetDir: string
  ): Promise<void> {
    // Read the source before making changes in this directory. If this fails,
    // stale items in this directory will not be archived.
    const targetFolder = app.vault.getFolderByPath(targetDir);
    if (!targetFolder) {
      throw new Error(`Target folder disappeared during sync: ${targetDir}`);
    }

    const sourceEntries = await readSourceDirectory(sourceDir);
    const sourceNames = new Set(
      sourceEntries
        .filter(isSyncableEntry)
        .map((entry) => normalizeFileName(entry.name))
    );

    const hasCurrentTargetItems = targetFolder.children.some(
      (item) => !isArchivedName(item.name)
    );

    // OneDrive can briefly expose an incomplete directory while it hydrates
    // its contents. Never turn that transient state into archived files.
    if (sourceNames.size === 0 && hasCurrentTargetItems) {
      throw new Error(
        `Source directory is empty while the target contains files; ` +
          `skipping archive step: ${sourceDir}`
      );
    }

    for (const entry of sourceEntries) {
      // Never follow symlinks outside the source tree.
      if (!isSyncableEntry(entry)) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = normalizePath(
        `${targetDir}/${normalizeFileName(entry.name)}`
      );
      const existing = app.vault.getAbstractFileByPath(targetPath);

      if (entry.isDirectory()) {
        if (existing instanceof TFile) {
          throw new Error(
            `Cannot create folder: a file already exists at ${targetPath}`
          );
        }

        if (!existing) {
          await app.vault.createFolder(targetPath);
        } else if (!(existing instanceof TFolder)) {
          throw new Error(`Unexpected vault item at ${targetPath}`);
        }

        await mirrorDirectory(sourcePath, targetPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (existing instanceof TFolder) {
        throw new Error(
          `Cannot copy file: a folder already exists at ${targetPath}`
        );
      }

      let sourceBuffer: Buffer | null = null;
      let lastReadError: unknown;

      for (let attempt = 1; attempt <= SOURCE_FILE_READ_RETRIES; attempt++) {
        try {
          sourceBuffer = await readFile(sourcePath);
          break;
        } catch (error) {
          lastReadError = error;
          if (attempt < SOURCE_FILE_READ_RETRIES) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, SOURCE_READ_RETRY_DELAY_MS)
            );
          }
        }
      }

      if (!sourceBuffer) {
        throw new Error(
          `Could not read GoodNotes file "${sourcePath}": ${
            lastReadError instanceof Error
              ? lastReadError.message
              : String(lastReadError)
          }`
        );
      }

      const data = toArrayBuffer(sourceBuffer);

      if (existing instanceof TFile) {
        const existingData = await app.vault.readBinary(existing);
        if (Buffer.from(existingData).equals(sourceBuffer)) {
          continue;
        }

        await app.vault.modifyBinary(existing, data);
      } else {
        await app.vault.createBinary(targetPath, data);
      }
    }

    // Archive target-only items after processing current source entries.
    // A missing source item may be a rename or deletion; nothing is deleted.
    for (const targetItem of [...targetFolder.children]) {
      if (isArchivedName(targetItem.name)) {
        continue;
      }

      if (!sourceNames.has(normalizeFileName(targetItem.name))) {
        await archiveVaultItem(app, targetItem);
      }
    }
  }

  await mirrorDirectory(sourceRoot, targetRoot);
}

/**
 * Mirrors each local OneDrive GoodNotes module into its Obsidian counterpart.
 */
async function performGoodNotesSync(app: App): Promise<void> {
  new Notice("Syncing GoodNotes materials...");

  try {
    const goodnotesModules = await readSourceDirectory(
      GOODNOTES_MODULES_FOLDER_PATH
    );

    let syncedModules = 0;
    const warnings: string[] = [];

    for (const moduleEntry of goodnotesModules) {
      if (!moduleEntry.isDirectory() || moduleEntry.isSymbolicLink()) {
        continue;
      }

      const sourceModuleName = moduleEntry.name;
      const moduleName = normalizeFileName(sourceModuleName);
      const sourceModulePath = path.join(
        GOODNOTES_MODULES_FOLDER_PATH,
        sourceModuleName
      );
      const targetFolderPath = normalizePath(
        path.join(
          MODULES_FOLDER_PATH,
          moduleName,
          OBSIDIAN_GOODNOTES_FOLDER_PATH
        )
      );

      const targetFolder = app.vault.getFolderByPath(targetFolderPath);

      if (!targetFolder) {
        warnings.push(
          `GoodNotes folder for module "${moduleName}" not found in Obsidian.`
        );
        continue;
      }

      try {
        await mirrorFolderContents(app, sourceModulePath, targetFolder.path);
        syncedModules++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`GoodNotes sync failed for module "${moduleName}":`, error);
        warnings.push(`Module "${moduleName}" was not synced: ${message}`);
      }
    }

    if (warnings.length > 0) {
      new Notice(warnings.join("\n"), 8000);
    }

    new Notice(`GoodNotes sync completed. Modules synced: ${syncedModules}.`);
  } catch (error) {
    console.error("GoodNotes sync failed:", error);
    new Notice(
      `GoodNotes sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      8000
    );
  }
}

/**
 * Serializes sync runs so the startup sync, interval, and command cannot
 * mutate the same vault folder concurrently.
 */
async function syncGoodNotes(app: App): Promise<void> {
  if (syncInProgress) {
    await syncInProgress;
    return;
  }

  syncInProgress = performGoodNotesSync(app);
  try {
    await syncInProgress;
  } finally {
    syncInProgress = null;
  }
}

/** Recursively collect files inside a GoodNotes folder. */
function getAllFilesInFolder(folder: TFolder): TFile[] {
  const files: TFile[] = [];

  for (const child of folder.children) {
    if (child instanceof TFile) {
      // Archived items are not current GoodNotes mirrors.
      if (!isArchivedName(child.name)) {
        files.push(child);
      }
    } else if (child instanceof TFolder) {
      if (!isArchivedName(child.name)) {
        files.push(...getAllFilesInFolder(child));
      }
    }
  }

  return files;
}

/**
 * Updates only the content below the GoodNotes heading.
 * Returns null when the heading is missing or the content is already correct.
 */
function updateGoodNotesSection(
  content: string,
  goodnotesFiles: TFile[]
): string | null {
  const headingRegex = /^## Goodnotes Material[ \t]*$/gm;
  const headingMatch = headingRegex.exec(content);

  if (!headingMatch || headingMatch[0].trim() !== GOODNOTES_SECTION_HEADING) {
    return null;
  }

  const headingEnd = headingMatch.index + headingMatch[0].length;
  let bodyStart = headingEnd;

  if (content.startsWith("\r\n", bodyStart)) {
    bodyStart += 2;
  } else if (content.startsWith("\n", bodyStart)) {
    bodyStart += 1;
  }

  // The section ends at the next H1/H2 heading. Lower-level headings remain
  // inside this section.
  const nextHeadingRegex = /^#{1,2}[ \t]+.*$/gm;
  nextHeadingRegex.lastIndex = bodyStart;
  const nextHeadingMatch = nextHeadingRegex.exec(content);
  const bodyEnd = nextHeadingMatch?.index ?? content.length;

  const sortedFiles = [...goodnotesFiles].sort((a, b) =>
    a.path.localeCompare(b.path)
  );

  const listItems = sortedFiles.map(
    (file) => `- [[${file.path}|${file.basename}]]`
  );

  const replacementLines =
    listItems.length > 0
      ? listItems
      : [GOODNOTES_NO_MATERIAL_TEXT];

  const hasNextHeading = bodyEnd < content.length;
  const replacementBody =
    replacementLines.join("\n") + (hasNextHeading ? "\n\n" : "\n");

  const currentBody = content.slice(bodyStart, bodyEnd);

  if (currentBody === replacementBody) {
    return null;
  }

  return (
    content.slice(0, bodyStart) +
    replacementBody +
    content.slice(bodyEnd)
  );
}

/**
 * Updates each lecture's material list using only GoodNotes files with the
 * same YYYY-MM-DD filename prefix as that lecture.
 */
async function checkLecturesForGoodNotesMaterials(
  app: App
): Promise<void> {
  new Notice("Checking lectures for GoodNotes materials...");

  const modulesFolder = app.vault.getFolderByPath(
    normalizePath(MODULES_FOLDER_PATH)
  );

  if (!modulesFolder) {
    new Notice("Modules folder not found.");
    return;
  }

  let updatedCount = 0;
  let unchangedCount = 0;
  let missingHeadingCount = 0;
  let missingDateCount = 0;

  for (const moduleFolder of modulesFolder.children) {
    if (!(moduleFolder instanceof TFolder)) {
      continue;
    }

    const goodnotesFolderPath = normalizePath(
      path.join(moduleFolder.path, OBSIDIAN_GOODNOTES_FOLDER_PATH)
    );
    const goodnotesFolder = app.vault.getFolderByPath(goodnotesFolderPath);
    const allGoodnotesFiles = goodnotesFolder
      ? getAllFilesInFolder(goodnotesFolder)
      : [];

    const lecturesFolderPath = normalizePath(
      path.join(moduleFolder.path, LECTURES_FOLDER_NAME)
    );
    const lecturesFolder = app.vault.getFolderByPath(lecturesFolderPath);

    if (!lecturesFolder) {
      continue;
    }

    // Preserve current behavior: lecture notes directly inside Lectures.
    for (const lectureFile of lecturesFolder.children) {
      if (
        !(lectureFile instanceof TFile) ||
        lectureFile.extension !== "md"
      ) {
        continue;
      }

      const lectureDate = getDatePrefix(lectureFile.basename);
      if (!lectureDate) {
        missingDateCount++;
      }

      const matchingGoodnotesFiles = lectureDate
        ? allGoodnotesFiles.filter(
            (file) => getDatePrefix(file.basename) === lectureDate
          )
        : [];

      const currentContent = await app.vault.read(lectureFile);
      const updatedContent = updateGoodNotesSection(
        currentContent,
        matchingGoodnotesFiles
      );

      if (updatedContent === null) {
        if (!currentContent.includes(GOODNOTES_SECTION_HEADING)) {
          missingHeadingCount++;
        } else {
          unchangedCount++;
        }
        continue;
      }

      await app.vault.modify(lectureFile, updatedContent);
      updatedCount++;
    }
  }

  new Notice(
    `GoodNotes check complete. Updated: ${updatedCount}, ` +
      `unchanged: ${unchangedCount}, ` +
      `missing heading: ${missingHeadingCount}, ` +
      `lecture files without a date prefix: ${missingDateCount}.`,
    8000
  );
}

export { syncGoodNotes, checkLecturesForGoodNotesMaterials };
