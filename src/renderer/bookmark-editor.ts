// The bookmark edit dialog: name, URL, and folder.
interface EditorData {
  isNew: boolean
  folder: boolean
  title: string
  url: string
  parentId: string
  folders: { id: string; title: string; depth: number }[]
}

interface EditorApi {
  get(): Promise<EditorData | null>
  save(patch: { title: string; url?: string; parentId: string }): Promise<void>
  remove(): Promise<void>
  cancel(): Promise<void>
}

const editor = (window as unknown as { editor: EditorApi }).editor
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const title = $<HTMLInputElement>('title')
const url = $<HTMLInputElement>('url')
const folder = $<HTMLSelectElement>('folder')

editor.get().then((data) => {
  if (!data) return void editor.cancel()
  document.title = data.isNew ? (data.folder ? 'New folder' : 'Bookmark added') : data.folder ? 'Rename folder' : 'Edit bookmark'
  title.value = data.title
  url.value = data.url
  $('url-row').hidden = data.folder
  for (const f of data.folders) {
    const option = document.createElement('option')
    option.value = f.id
    option.textContent = `${' '.repeat(f.depth)}${f.title}`
    option.selected = f.id === data.parentId
    folder.append(option)
  }
  title.focus()
  title.select()
})

$<HTMLFormElement>('form').addEventListener('submit', (e) => {
  e.preventDefault()
  void editor.save({ title: title.value, url: $('url-row').hidden ? undefined : url.value, parentId: folder.value })
})
$('remove').onclick = () => void editor.remove()
$('cancel').onclick = () => void editor.cancel()
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void editor.cancel()
})
