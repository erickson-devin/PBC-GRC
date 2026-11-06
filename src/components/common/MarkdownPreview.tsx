import React from 'react';
import { Block, Callout, Inline, parseMarkdownBlocks } from '../../utils/markdownBlocks';

/**
 * The formatted view of a generated Markdown document (policies, the enclave policy preview). The text is parsed into blocks
 * and drawn as React elements only: raw HTML in the text stays text, nothing is injected as markup.
 * `headingOffset` shifts the heading tags (a Markdown `##` becomes an h3 with an offset of 1) so the page keeps its outline.
 */
interface MarkdownPreviewProps {
  markdown: string;
  headingOffset?: number;
  className?: string;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-bold text-white border-b border-slate-800 pb-2 pt-2',
  2: 'text-base font-bold text-cyan-300 border-b border-slate-800/60 pb-1 pt-3',
  3: 'text-sm font-bold text-indigo-300 pt-2',
  4: 'text-xs font-bold uppercase tracking-wider text-slate-300 pt-2',
  5: 'text-xs font-bold uppercase tracking-wider text-slate-300 pt-2',
  6: 'text-xs font-bold uppercase tracking-wider text-slate-300 pt-2',
};

const CALLOUT_LABEL: Record<Callout, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

const renderInline = (nodes: Inline[]): React.ReactNode[] =>
  nodes.map((n, i) => {
    switch (n.t) {
      case 'strong':
        return (
          <strong key={i} className="font-semibold text-white">
            {renderInline(n.c)}
          </strong>
        );
      case 'em':
        return (
          <em key={i} className="italic text-slate-200">
            {renderInline(n.c)}
          </em>
        );
      case 'code':
        return (
          <code key={i} className="px-1 py-0.5 rounded bg-slate-800 text-cyan-200 font-mono text-[11px]">
            {n.v}
          </code>
        );
      default:
        return <React.Fragment key={i}>{n.v}</React.Fragment>;
    }
  });

const renderLines = (lines: Inline[][]): React.ReactNode[] =>
  lines.map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(line)}
    </React.Fragment>
  ));

export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({ markdown, headingOffset = 0, className }) => {
  const blocks = parseMarkdownBlocks(markdown);

  const renderBlock = (block: Block, idx: number): React.ReactNode => {
    switch (block.t) {
      case 'heading': {
        const Tag = `h${Math.min(6, block.level + headingOffset)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return (
          <Tag key={idx} className={HEADING_CLASS[block.level]}>
            {renderInline(block.c)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={idx} className="text-xs text-slate-300 leading-relaxed">
            {renderLines(block.lines)}
          </p>
        );
      case 'list': {
        const items = block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
        return block.ordered ? (
          <ol key={idx} start={block.start} className="list-decimal pl-5 space-y-1 text-xs text-slate-300 leading-relaxed">
            {items}
          </ol>
        ) : (
          <ul key={idx} className="list-disc pl-5 space-y-1 text-xs text-slate-300 leading-relaxed">
            {items}
          </ul>
        );
      }
      case 'table':
        return (
          <div key={idx} className="overflow-x-auto my-3">
            <table className="w-full text-xs text-left border-collapse border border-slate-800">
              {block.head && (
                <thead className="bg-slate-900 text-cyan-300">
                  <tr>
                    {block.head.map((cell, c) => (
                      <th key={c} scope="col" className="p-2.5 font-bold border-b border-slate-800">
                        {renderInline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="border-b border-slate-800/60">
                    {row.map((cell, c) => (
                      <td key={c} className="p-2.5 align-top">
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'quote': {
        if (!block.callout) {
          return (
            <blockquote
              key={idx}
              className="p-3 rounded-xl bg-indigo-950/30 border-l-4 border-indigo-500 text-xs text-indigo-200 leading-relaxed"
            >
              {renderLines(block.lines)}
            </blockquote>
          );
        }
        const info = block.callout === 'NOTE' || block.callout === 'TIP';
        return (
          <div
            key={idx}
            role="note"
            className={
              info
                ? 'p-3 rounded-xl bg-sky-950/30 border-l-4 border-sky-500 text-xs text-sky-100 leading-relaxed'
                : 'p-3 rounded-xl bg-amber-950/30 border-l-4 border-amber-500 text-xs text-amber-100 leading-relaxed'
            }
          >
            <p
              className={`text-[11px] font-bold uppercase tracking-wider mb-1 ${info ? 'text-sky-300' : 'text-amber-300'}`}
            >
              {CALLOUT_LABEL[block.callout]}
            </p>
            {renderLines(block.lines)}
          </div>
        );
      }
      case 'code':
        return (
          <pre
            key={idx}
            className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 whitespace-pre-wrap overflow-x-auto"
          >
            {block.text}
          </pre>
        );
      default:
        return <hr key={idx} className="border-slate-800" />;
    }
  };

  return <div className={className}>{blocks.map(renderBlock)}</div>;
};

export default MarkdownPreview;
