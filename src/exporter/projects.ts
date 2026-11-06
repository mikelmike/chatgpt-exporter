import JSZip from 'jszip'
import sanitize from 'sanitize-filename'
import {
    RateLimitError,
    downloadFileById,
    fetchConversation,
    fetchProjectConversations,
    fetchProjectsWithFiles,
    processConversation,
    replaceImageSources,
    withImageAssets,
} from '../api'
import { KEY_THINKING_ENABLED } from '../constants'
import i18n from '../i18n'
import { downloadFile } from '../utils/download'
import { ScriptStorage } from '../utils/storage'
import { dateStr, sleep } from '../utils/utils'
import type { ApiConversationItem, ApiConversationWithId } from '../api'
import { conversationToMarkdown } from './markdown'
import { markdownToPdf, toPdfImage } from './pdf'

const REQUEST_GAP_MS = 300
const MAX_ATTEMPTS = 3
const MAX_RATE_LIMIT_WAITS = 20

export type ProgressReporter = (key: string, options?: Record<string, string | number>) => void

export interface ProjectsZipResult {
    blob: Blob
    projects: number
    chats: number
    files: number
    errors: string[]
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function safeName(name: string | null | undefined, fallback: string): string {
    return sanitize(name ?? '').trim().slice(0, 120) || sanitize(fallback).slice(0, 120) || 'untitled'
}

/** Adds " (2)", " (3)"... before the extension when the name is already taken */
function uniqueName(taken: Set<string>, name: string): string {
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = name
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})${ext}`
    taken.add(candidate.toLowerCase())
    return candidate
}

async function withRetry<T>(task: () => Promise<T>, report: ProgressReporter): Promise<T> {
    let failures = 0
    let waits = 0
    while (true) {
        try {
            return await task()
        }
        catch (error) {
            if (error instanceof RateLimitError && waits < MAX_RATE_LIMIT_WAITS) {
                waits++
                report('Projects Export Rate Limited', { n: Math.ceil(error.retryAfterMs / 1000) })
                await sleep(error.retryAfterMs)
                continue
            }
            if (error instanceof RateLimitError || ++failures >= MAX_ATTEMPTS) throw error
            await sleep(1000 * 2 ** failures)
        }
    }
}

async function fetchAllProjectConversations(projectId: string, report: ProgressReporter): Promise<ApiConversationItem[]> {
    const items: ApiConversationItem[] = []
    const seen = new Set<string>()
    let cursor: string | number = 0
    while (true) {
        const page = await withRetry(() => fetchProjectConversations(projectId, cursor, 50), report)
        for (const item of page.items) {
            if (seen.has(item.id)) continue
            seen.add(item.id)
            items.push(item)
        }
        if (page.items.length === 0 || !page.cursor) break
        cursor = page.cursor
        await sleep(REQUEST_GAP_MS)
    }
    return items
}

function fileAttachments(conversation: ApiConversationWithId) {
    const result = new Map<string, { id: string, name: string }>()
    for (const node of Object.values(conversation.mapping ?? {})) {
        for (const attachment of node.message?.metadata?.attachments ?? []) {
            if (!attachment.id || attachment.mime_type?.startsWith('image/')) continue
            result.set(attachment.id, { id: attachment.id, name: attachment.name })
        }
    }
    return [...result.values()]
}

/**
 * Builds one ZIP with a folder per project:
 * instructions.txt, files/, a PDF per chat and attachments/<chat>/.
 * A broken chat or file is written to _errors.txt instead of stopping the export.
 */
export async function buildProjectsPdfZip(report: ProgressReporter = () => {}): Promise<ProjectsZipResult> {
    const zip = new JSZip()
    const errors: string[] = []
    const enableThinking = ScriptStorage.get<boolean>(KEY_THINKING_ENABLED) ?? true
    let chats = 0
    let files = 0

    report('Projects Export Loading')
    const projects = await withRetry(() => fetchProjectsWithFiles(), report)
    const projectFolders = new Set<string>()

    for (const [projectIndex, { info, files: projectFiles }] of projects.entries()) {
        const projectName = info.display?.name || 'Project'
        const folderName = uniqueName(projectFolders, safeName(projectName, info.id))
        const folder = zip.folder(folderName)!
        const progress = { project: projectName, p: projectIndex + 1, pt: projects.length, c: 0, ct: 0 }
        report('Projects Export Progress', progress)

        const instructions = info.instructions?.trim()
        if (instructions) folder.file('instructions.txt', `${instructions}\n`)

        const fileNames = new Set<string>()
        for (const file of projectFiles) {
            const fileId = file.file_id || file.id
            if (!fileId) continue
            try {
                const { blob, fileName } = await withRetry(() => downloadFileById(fileId, { gizmo_id: info.id }), report)
                folder.file(`files/${uniqueName(fileNames, safeName(file.name || fileName, fileId))}`, await blob.arrayBuffer())
                files++
            }
            catch (error) {
                errors.push(`${folderName} / files / ${file.name || fileId}: ${errorText(error)}`)
            }
            await sleep(REQUEST_GAP_MS)
        }

        let items: ApiConversationItem[]
        try {
            items = await fetchAllProjectConversations(info.id, report)
        }
        catch (error) {
            errors.push(`${folderName}: ${errorText(error)}`)
            continue
        }

        const chatNames = new Set<string>()
        progress.ct = items.length
        for (const [chatIndex, item] of items.entries()) {
            progress.c = chatIndex + 1
            report('Projects Export Progress', progress)
            try {
                const rawConversation = await withRetry(() => fetchConversation(item.id), report)
                const withImages = await withImageAssets(rawConversation)
                await replaceImageSources(withImages, src => toPdfImage(src).catch(() => null))
                const conversation = processConversation(withImages, { enableThinking })
                const markdown = conversationToMarkdown(conversation, [], 'embed')
                const chatName = uniqueName(chatNames, `${safeName(conversation.title || item.title, item.id)}.pdf`)
                folder.file(chatName, await (await markdownToPdf(markdown)).arrayBuffer())
                chats++

                const attachmentNames = new Set<string>()
                for (const attachment of fileAttachments(rawConversation)) {
                    try {
                        const { blob, fileName } = await withRetry(() => downloadFileById(attachment.id, { conversation_id: item.id }), report)
                        const name = uniqueName(attachmentNames, safeName(attachment.name || fileName, attachment.id))
                        folder.file(`attachments/${chatName.replace(/\.pdf$/, '')}/${name}`, await blob.arrayBuffer())
                        files++
                    }
                    catch (error) {
                        errors.push(`${folderName} / ${chatName} / ${attachment.name || attachment.id}: ${errorText(error)}`)
                    }
                    await sleep(REQUEST_GAP_MS)
                }
            }
            catch (error) {
                errors.push(`${folderName} / ${item.title || item.id}: ${errorText(error)}`)
            }
            await sleep(REQUEST_GAP_MS)
        }
    }

    if (errors.length > 0) zip.file('_errors.txt', `${errors.join('\n')}\n`)

    report('Projects Export Packing')
    const blob = await zip.generateAsync({
        type: 'blob',
        platform: 'UNIX',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
    })
    return { blob, projects: projects.length, chats, files, errors }
}

function createToast() {
    const element = document.createElement('div')
    element.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:2147483647',
        'max-width:380px',
        'padding:10px 14px',
        'border-radius:8px',
        'background:#202123',
        'color:#fff',
        'font:13px/1.4 system-ui,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.3)',
        'white-space:pre-wrap',
    ].join(';')
    document.body.append(element)
    return {
        set: (text: string) => { element.textContent = text },
        close: (delay: number) => setTimeout(() => element.remove(), delay),
    }
}

/** One click: every project of the signed-in account into a single ZIP of PDFs */
export async function exportAllProjectsToPdf(): Promise<boolean> {
    const toast = createToast()
    try {
        const result = await buildProjectsPdfZip((key, options) => toast.set(i18n.t(key, options)))
        if (result.projects === 0) {
            toast.set(i18n.t('Projects Export None'))
            toast.close(6000)
            return false
        }
        downloadFile(`chatgpt-projects-${dateStr()}.zip`, 'application/zip', result.blob)
        const done = i18n.t('Projects Export Done', { projects: result.projects, chats: result.chats, files: result.files })
        toast.set(result.errors.length ? `${done}\n${i18n.t('Projects Export Errors', { n: result.errors.length })}` : done)
        toast.close(result.errors.length ? 20000 : 8000)
        return true
    }
    catch (error) {
        console.error(error)
        toast.set(i18n.t('Projects Export Failed', { error: errorText(error) }))
        toast.close(20000)
        return false
    }
}
