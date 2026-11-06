import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markdownToPdf } from '../src/exporter/pdf'
import type { ApiConversationWithId } from '../src/api'

vi.mock('vite-plugin-monkey/dist/client', () => ({ unsafeWindow: {} }))
vi.stubGlobal('location', { href: 'https://chatgpt.com/' })
vi.stubGlobal('document', { documentElement: { lang: 'en' } })

vi.mock('../src/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../src/page', () => ({ getUserAvatar: async () => '' }))
vi.mock('../src/temporaryChat', () => ({}))
vi.mock('../src/utils/storage', () => ({ ScriptStorage: { get: () => null } }))

const api = vi.hoisted(() => ({
    fetchProjectsWithFiles: vi.fn(),
    fetchProjectConversations: vi.fn(),
    fetchConversation: vi.fn(),
    downloadFileById: vi.fn(),
}))

vi.mock('../src/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/api')>()
    return { ...actual, ...api }
})

vi.mock('../src/utils/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/utils/utils')>()
    return { ...actual, sleep: () => Promise.resolve() }
})

function conversation(id: string, title: string, text: string): ApiConversationWithId {
    return {
        id,
        title,
        create_time: 1700000000,
        update_time: 1700000100,
        current_node: 'a1',
        moderation_results: [],
        mapping: {
            root: { id: 'root', children: ['u1'] },
            u1: {
                id: 'u1',
                parent: 'root',
                children: ['a1'],
                message: {
                    id: 'u1',
                    author: { role: 'user', metadata: {} },
                    content: { content_type: 'text', parts: ['Привет! Explain **this**'] },
                    create_time: 1700000000,
                    metadata: { attachments: [{ id: 'file-att', name: 'notes.docx', mime_type: 'application/msword' }] },
                    recipient: 'all',
                    status: 'finished_successfully',
                    weight: 1,
                    end_turn: null,
                },
            },
            a1: {
                id: 'a1',
                parent: 'u1',
                children: [],
                message: {
                    id: 'a1',
                    author: { role: 'assistant', metadata: {} },
                    content: { content_type: 'text', parts: [text] },
                    create_time: 1700000050,
                    metadata: {},
                    recipient: 'all',
                    status: 'finished_successfully',
                    weight: 1,
                    end_turn: true,
                },
            },
        },
    } as unknown as ApiConversationWithId
}

const richMarkdown = [
    '# Заголовок',
    '',
    'Text with **bold**, *italic*, ~~strike~~, ' + '\u0060code\u0060' + ' and [a link](https://example.com) 😀.',
    '',
    '- one',
    '- two',
    '  1. nested',
    '',
    '> quote',
    '',
    '\u0060\u0060\u0060js',
    'const answer = 42',
    '\u0060\u0060\u0060',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '---',
    '',
    '![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)',
].join('\n')

describe('markdownToPdf', () => {
    it('renders markdown with Cyrillic, tables, code and images into a PDF', async () => {
        const blob = await markdownToPdf(richMarkdown)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
        expect(bytes.length).toBeGreaterThan(1000)
    })
})

describe('buildProjectsPdfZip', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('puts every project into its own folder with instructions, files and chat PDFs', async () => {
        api.fetchProjectsWithFiles.mockResolvedValue([
            {
                info: { id: 'g-p-1', organization_id: 'org', display: { name: 'Работа', description: '' }, instructions: 'Be brief' },
                files: [
                    { id: 'pf1', file_id: 'file-1', name: 'spec.pdf' },
                    { id: 'pf2', file_id: 'file-broken', name: 'gone.txt' },
                ],
            },
            {
                info: { id: 'g-p-2', organization_id: 'org', display: { name: 'Работа', description: '' } },
                files: [],
            },
        ])
        api.fetchProjectConversations.mockImplementation(async (project: string, cursor: string | number) => {
            if (project === 'g-p-1' && cursor === 0) return { items: [{ id: 'c1', title: 'Chat/One' }], cursor: 'next' }
            if (project === 'g-p-1' && cursor === 'next') return { items: [{ id: 'c2', title: 'Chat/One' }, { id: 'c3', title: 'Broken' }], cursor: null }
            return { items: [], cursor: null }
        })
        api.fetchConversation.mockImplementation(async (id: string) => {
            if (id === 'c3') throw new Error('boom')
            return conversation(id, 'Chat/One', richMarkdown)
        })
        api.downloadFileById.mockImplementation(async (id: string) => {
            if (id === 'file-broken') throw new Error('File not found')
            return { blob: new Blob([`content of ${id}`]), fileName: id }
        })

        const { buildProjectsPdfZip } = await import('../src/exporter/projects')
        const result = await buildProjectsPdfZip()

        expect(result).toMatchObject({ projects: 2, chats: 2, files: 3 })
        expect(result.errors).toHaveLength(2)

        const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
        const names = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort()
        expect(names).toEqual([
            '_errors.txt',
            'Работа/ChatOne (2).pdf',
            'Работа/ChatOne.pdf',
            'Работа/attachments/ChatOne (2)/notes.docx',
            'Работа/attachments/ChatOne/notes.docx',
            'Работа/files/spec.pdf',
            'Работа/instructions.txt',
        ])
        expect(zip.files['Работа (2)/']).toBeDefined()
        expect(await zip.file('Работа/instructions.txt')!.async('string')).toBe('Be brief\n')
        expect(await zip.file('Работа/files/spec.pdf')!.async('string')).toBe('content of file-1')
        const pdf = await zip.file('Работа/ChatOne.pdf')!.async('uint8array')
        expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
        const errors = await zip.file('_errors.txt')!.async('string')
        expect(errors).toContain('gone.txt: File not found')
        expect(errors).toContain('Broken: boom')
        expect(api.downloadFileById).toHaveBeenCalledWith('file-1', { gizmo_id: 'g-p-1' })
        expect(api.downloadFileById).toHaveBeenCalledWith('file-att', { conversation_id: 'c1' })
    })
})
