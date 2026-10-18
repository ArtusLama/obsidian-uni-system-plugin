import {
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
	FileManager,
	TFolder,
	App,
	TFile
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	UniSystemPluginSettings,
	SampleSettingTab,
} from "./settings";
import { setupNewModule } from "./moduleSetup";
import { getDropdownModal, getTextInputModal, TextInputModal } from "./modals";
import { createNewLecture } from "./lectures";
import { checkLecturesForGoodNotesMaterials, syncGoodNotes } from "./goodnotesSync";

// Remember to rename these classes and interfaces!

const MODULES_FOLDER_PATH = "01 Modules";
const LECTURE_TEMPLATE_PATH = "System/Templates/LECTURE_TEMPLATE.md";
const MODULE_TEMPLATE_FOLDER_PATH = "System/Templates/MODULE_TEMPLATE";
const LECTURES_FOLDER_NAME = "Vorlesungen";
const MATERIALS_FOLDER_NAME = "Materialien";
const OBSIDIAN_GOODNOTES_FOLDER_PATH = MATERIALS_FOLDER_NAME + "/GoodNotes";


export default class UniSystemPlugin extends Plugin {
	settings!: UniSystemPluginSettings;

	async onload() {
		await this.loadSettings();


		const newLecture = async () => {
			const templateFile = this.app.vault.getFileByPath(LECTURE_TEMPLATE_PATH);
			
			const modulesFolder = this.app.vault.getFolderByPath(MODULES_FOLDER_PATH);
			const modules = modulesFolder?.children.filter((child) => child instanceof TFolder).map((folder) => folder.name) || [];

			const module = await getDropdownModal(this.app, "Select Module", modules);
			if (module) {
				const lecturesFolder = this.app.vault.getFolderByPath(`${MODULES_FOLDER_PATH}/${module}/${LECTURES_FOLDER_NAME}`);

				if (lecturesFolder instanceof TFolder && templateFile instanceof TFile && modulesFolder instanceof TFolder) {
					const lectureFile = await createNewLecture(this.app, module, templateFile, lecturesFolder);
					if (lectureFile) {
						await this.app.workspace.getLeaf().openFile(lectureFile);
					}
				} else {
					new Notice("Error creating new lecture!");
				}

			} else {
				new Notice("No module selected. Lecture creation canceled.");
				return;
			}
		}

		
		this.addRibbonIcon("file-plus-corner", "New Lecture", newLecture);
		this.addCommand({
			id: "create-new-lecture",
			name: "Create new lecture",
			callback: newLecture
		});



		this.addCommand({
			id: "create-new-module-setup",
			name: "Create new module setup",
			callback: async () => {
				const templateFolder = this.app.vault.getFolderByPath(MODULE_TEMPLATE_FOLDER_PATH);
				const modulesFolder = this.app.vault.getFolderByPath(MODULES_FOLDER_PATH);

				if (templateFolder instanceof TFolder && modulesFolder instanceof TFolder) {
					const moduleName = await getTextInputModal(this.app, "Enter Module Name", "Module Name");
					if (moduleName) {
						await setupNewModule(moduleName, templateFolder, modulesFolder, this.app);

						await syncGoodNotes(this.app);
						await checkLecturesForGoodNotesMaterials(this.app);
					} else {
						new Notice("Module creation canceled.");
					}
				} else {
					new Notice("Template folder or Modules folder not found.");
				}
			}
		});



		await syncGoodNotes(this.app);
		await checkLecturesForGoodNotesMaterials(this.app);

		this.registerInterval(window.setInterval(async () => {
			await syncGoodNotes(this.app);
			await checkLecturesForGoodNotesMaterials(this.app);
		}, 1000 * 60 * 60)); // Every 60 minutes. Maybe make higher?!

		this.addCommand({
			id: "sync-goodnotes",
			name: "Sync GoodNotes",
			callback: async () => {
				new Notice("Syncing GoodNotes...");
				await syncGoodNotes(this.app);
				await checkLecturesForGoodNotesMaterials(this.app);
				new Notice("GoodNotes sync completed.");
			}
		});


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<UniSystemPluginSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

export { 
	MODULES_FOLDER_PATH,
	LECTURE_TEMPLATE_PATH,
	MODULE_TEMPLATE_FOLDER_PATH,
	LECTURES_FOLDER_NAME,
	MATERIALS_FOLDER_NAME,
	OBSIDIAN_GOODNOTES_FOLDER_PATH
};