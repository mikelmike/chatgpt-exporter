import pdfMake from 'pdfmake/build/pdfmake'
import pdfFonts from 'pdfmake/build/vfs_fonts'
import type { Content as MdContent, PhrasingContent } from 'mdast'
import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces'
import { fromMarkdown } from '../utils/markdown'

// The userscript build loads the fonts from a CDN script that registers them by itself.
if (pdfFonts && typeof pdfFonts === 'object' && 'Roboto-Regular.ttf' in pdfFonts) {
    pdfMake.vfs = pdfFonts as unknown as typeof pdfMake.vfs
}

/** A4 width minus the page margins, in points */
const CONTENT_WIDTH = 595.28 - 80
const PDF_IMAGE = /^data:image\/(?:png|jpe?g);base64,/i

type Inline = Omit<ContentText, 'text'> & { text: string }
type InlineStyle = Omit<Inline, 'text'>

/** Roboto has no emoji glyphs, they would print as empty boxes */
function clean(value: string): string {
    return value.replace(/\p{Extended_Pictographic}|\u200D|\uFE0F/gu, '')
}

function stripTags(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, '\'')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
}

function inlines(nodes: PhrasingContent[], style: InlineStyle = {}): Inline[] {
    return nodes.flatMap((node): Inline[] => {
        switch (node.type) {
            case 'text': return [{ ...style, text: clean(node.value) }]
            case 'strong': return inlines(node.children, { ...style, bold: true })
            case 'emphasis': return inlines(node.children, { ...style, italics: true })
            case 'delete': return inlines(node.children, { ...style, decoration: 'lineThrough' })
            case 'inlineCode': return [{ ...style, text: clean(node.value), background: '#eeeeee', color: '#b4235a' }]
            case 'link': return inlines(node.children, { ...style, link: node.url, color: '#1a5fb4' })
            case 'break': return [{ ...style, text: '\n' }]
            case 'html': return [{ ...style, text: clean(stripTags(node.value)) }]
            case 'image': return [{ ...style, text: `[${node.alt || 'image'}]` }]
            case 'footnoteReference': return [{ ...style, text: `[${node.label ?? node.identifier}]` }]
            default: return 'children' in node ? inlines(node.children as PhrasingContent[], style) : []
        }
    })
}

/** Images can not sit inside a pdfmake text run, so a paragraph is split around them */
function paragraph(children: PhrasingContent[]): Content[] {
    const result: Content[] = []
    let run: PhrasingContent[] = []
    const flush = () => {
        const text = inlines(run)
        if (text.some(part => part.text.trim())) result.push({ text, margin: [0, 0, 0, 6] })
        run = []
    }
    for (const child of children) {
        if (child.type === 'image' && PDF_IMAGE.test(child.url)) {
            flush()
            result.push({ image: child.url, fit: [CONTENT_WIDTH, 600], margin: [0, 2, 0, 8] })
        }
        else {
            run.push(child)
        }
    }
    flush()
    return result
}

const codeLayout = {
    hLineWidth: () => 0,
    vLineWidth: () => 0,
    fillColor: () => '#f4f4f4',
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
}

function blocks(nodes: MdContent[]): Content[] {
    return nodes.flatMap((node): Content[] => {
        switch (node.type) {
            case 'heading':
                return [{ text: inlines(node.children), style: `h${Math.min(node.depth, 4)}` }]
            case 'paragraph':
                return paragraph(node.children)
            case 'code':
                return [{
                    table: { widths: ['*'], body: [[{ text: clean(node.value), fontSize: 8.5, preserveLeadingSpaces: true }]] },
                    layout: codeLayout,
                    margin: [0, 2, 0, 8],
                }]
            case 'blockquote':
                return [{ stack: blocks(node.children), margin: [12, 0, 0, 6], color: '#555555' }]
            case 'list': {
                const items = node.children.map(item => ({ stack: blocks(item.children) }))
                if (items.length === 0) return []
                return node.ordered
                    ? [{ ol: items, start: node.start ?? 1, margin: [0, 0, 0, 6] }]
                    : [{ ul: items, margin: [0, 0, 0, 6] }]
            }
            case 'table': {
                const body = node.children.map((row, index) => row.children.map(cell => ({
                    text: cell.children.length ? inlines(cell.children) : '',
                    bold: index === 0,
                })))
                const columns = Math.max(0, ...body.map(row => row.length))
                if (columns === 0) return []
                body.forEach((row) => {
                    while (row.length < columns) row.push({ text: '', bold: false })
                })
                return [{
                    table: { headerRows: 1, widths: Array.from({ length: columns }, () => '*'), body },
                    layout: 'lightHorizontalLines',
                    fontSize: 9,
                    margin: [0, 2, 0, 8],
                }]
            }
            case 'thematicBreak':
                return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: '#cccccc' }], margin: [0, 6, 0, 6] }]
            case 'html': {
                const text = clean(stripTags(node.value)).trim()
                return text ? [{ text, margin: [0, 0, 0, 6], color: '#555555' }] : []
            }
            case 'footnoteDefinition':
                return [{ stack: [{ text: `[${node.label ?? node.identifier}]` }, ...blocks(node.children)], fontSize: 8 }]
            default:
                return 'children' in node ? blocks(node.children as MdContent[]) : []
        }
    })
}

export function markdownToPdfDefinition(markdown: string): TDocumentDefinitions {
    return {
        pageSize: 'A4',
        pageMargins: [40, 40, 40, 40],
        content: blocks(fromMarkdown(markdown).children),
        defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.2 },
        styles: {
            h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
            h2: { fontSize: 15, bold: true, margin: [0, 8, 0, 6] },
            h3: { fontSize: 12.5, bold: true, margin: [0, 8, 0, 4] },
            h4: { fontSize: 11, bold: true, color: '#10a37f', margin: [0, 12, 0, 4] },
        },
    }
}

export function markdownToPdf(markdown: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
        try {
            pdfMake.createPdf(markdownToPdfDefinition(markdown)).getBlob(resolve)
        }
        catch (error) {
            reject(error)
        }
    })
}

/**
 * pdfmake only reads PNG and JPEG. Other data uri images are redrawn as PNG,
 * anything else is left as is and printed as a placeholder.
 */
export async function toPdfImage(src: string): Promise<string | null> {
    if (!src.startsWith('data:image/') || PDF_IMAGE.test(src)) return null
    const bitmap = await createImageBitmap(await (await fetch(src)).blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas.toDataURL('image/png')
}
