import { App, Modal, Notice, Setting, TFolder } from "obsidian";


async function setupNewModule(name: string, templateFolder: TFolder, modulesFolder: TFolder, app: App): Promise<void> {
    // Copy Template Folder
    const newFolder = await app.vault.copy(templateFolder, modulesFolder.path + "/" + name)

    if (newFolder) {
        new Notice(`Module created: ${name}`);
    } else {
        new Notice("Failed to create module.");
        return;
    }
    
    // Setup Module Main File
    const mainFile = newFolder.children.find((child) => child.name === "MODULE_NAME.md");
    const moduleFile = app.vault.getFileByPath(mainFile?.path || "");
    if (mainFile && moduleFile) {
        await app.fileManager.renameFile(mainFile, newFolder.path + "/" + name + " - Modul" + ".md");
        await app.fileManager.processFrontMatter(moduleFile, (frontMatter) => {
            const currentYear = new Date().getFullYear();
            frontMatter["semester"] = `${currentYear}/${(currentYear + 1).toString().slice(-2)}`;
            frontMatter["module"] = name;
        });
        await app.vault.process(moduleFile, (content) => content.replaceAll("%MODULE_NAME%", name));
    } else {
        new Notice("Main file not found in the new module folder.");
    }

}




export { setupNewModule };