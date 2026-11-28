import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { pageImage, pageImageUrl } from '@socio/shared/page-image';

import './page-image.css';

/**
 * The picture block in the page editor (CB-358): the image this app serves
 * for the page's Space, by its embed id, so nothing loads from elsewhere.
 * When it can't be shown (deleted, or not readable here), a note takes its
 * place with the alt text, so the page still reads.
 */
export function PageImageBlock({ node, selected }: ReactNodeViewProps) {
    const { t } = useTranslation(['pages.editor']);
    const image = pageImage({
        id: node.attrs.id ?? undefined,
        alt: node.attrs.alt || undefined,
        width: node.attrs.width ?? undefined,
        height: node.attrs.height ?? undefined,
    });
    const [failed, setFailed] = useState<string | null>(null);
    const className = `page-image${selected ? ' selected' : ''}`;
    if (!image || failed === image.id) {
        return (
            <NodeViewWrapper className={className} contentEditable={false}>
                <div className="page-image-missing">
                    {image?.alt
                        ? t('pages.editor:image.missing-alt', { alt: image.alt })
                        : t('pages.editor:image.missing')}
                </div>
            </NodeViewWrapper>
        );
    }
    return (
        <NodeViewWrapper as="figure" className={className} contentEditable={false}>
            <img
                src={pageImageUrl(image.id)}
                alt={image.alt ?? ''}
                loading="lazy"
                decoding="async"
                width={image.width}
                height={image.height}
                draggable={false}
                onError={() => setFailed(image.id)}
            />
        </NodeViewWrapper>
    );
}
