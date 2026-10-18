import { App, Notice, TFile, TFolder } from "obsidian";
import { syncGoodNotes, checkLecturesForGoodNotesMaterials} from "./goodnotesSync";



async function createNewLecture(app: App, module: string, templateFile: TFile, lecturesFolder: TFolder): Promise<TFile | null> {
    const currentDate = new Date().toISOString().split("T")[0];

    // Copy Template File
    const newFile = await app.vault.copy(templateFile, lecturesFolder.path + "/" + `${currentDate} - New Lecture.md`);

    if (newFile) {
        new Notice(`Lecture created: ${newFile.name}`);
    } else {
        new Notice("Failed to create lecture.");
        return null;
    }

    // Setup Lecture File
    const lectureFile = app.vault.getFileByPath(newFile.path);
    if (lectureFile) {
        await app.fileManager.processFrontMatter(lectureFile, (frontMatter) => {
            frontMatter["module"] = module;
            frontMatter["date"] = currentDate;
        });
    } else {
        new Notice("Lecture file not found after creation.");
    }

    await syncGoodNotes(app);
    await checkLecturesForGoodNotesMaterials(app);

    return lectureFile;
}


export { createNewLecture };