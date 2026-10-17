import { App, Modal, Setting } from "obsidian";

class TextInputModal extends Modal {
  private submitted = false;
  private onSubmit: (value: string) => void;
  private onCancel?: () => void;

  constructor(app: App, title: string = "Enter a value", placeholder: string = "Type here…", onSubmit: (value: string) => void, onCancel?: () => void) {
    super(app);
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    let value = "";

    this.setTitle(title);
    
    new Setting(this.contentEl)
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .onChange((input) => (value = input))
      );

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("Submit")
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.onSubmit(value);
          })
      );
  }

  onClose() {
    if (!this.submitted) {
      this.onCancel?.();
    }
  }
}

async function getTextInputModal(app: App, title: string, placeholder: string, onCancel?: () => void): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new TextInputModal(app, title, placeholder, (value) => {
      resolve(value);
    }, () => {
      onCancel?.();
      resolve(null);
    });
    modal.open();
  });
}




class DropdownModal extends Modal {
  private submitted = false;
  private onSubmit: (value: string) => void;
  private onCancel?: () => void;

  constructor(app: App, title: string = "Select an option", options: string[], onSubmit: (value: string) => void, onCancel?: () => void) {
    super(app);
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    let selectedValue = options[0];

    this.setTitle(title);
    
    new Setting(this.contentEl)
      .addDropdown((dropdown) => {
        options.forEach((option) => {
          dropdown.addOption(option, option);
        });
        dropdown.onChange((value) => (selectedValue = value));
        return dropdown;
      });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close())
      )
      .addButton((button) =>
        button
          .setButtonText("Submit")
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.onSubmit(selectedValue || "");
          })
      );
  }

  onClose() {
    if (!this.submitted) {
      this.onCancel?.();
    }
  }
}

function getDropdownModal(app: App, title: string, options: string[], onCancel?: () => void): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new DropdownModal(
      app,
      title,
      options,
      (value) => resolve(value),
      () => {
        onCancel?.();
        resolve(null);
      }
    );
    modal.open();
  });
}

export { TextInputModal, getTextInputModal, DropdownModal, getDropdownModal };
