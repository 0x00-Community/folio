/// <reference types="@dopame/acde-api/app" />

// The DOM lib names showOpenFilePicker in a comment and does not declare it. acdert implements the standard picker.
interface OpenFilePickerOptions {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: Array<{
    description?: string
    accept: Record<string, string[] | readonly string[]>
  }>
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
}
