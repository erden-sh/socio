export interface ContentItem {
    kind: 'url' | 'email' | 'domain' | 'phone';
    text: string;
}
export function normalizeText(text: string): string;
export function contentItems(text: string): ContentItem[];
export function newContent(source: string, translation: string): ContentItem[];
export function newMarkup(source: string, translation: string): string[];
export function translationProblems(source: string, translation: string, markupSource?: string): string[];
export function tagStructure(text: string): { canonical: string; sequence: string; stray: string[] };
export function checkLocales(dir: string): string[];
