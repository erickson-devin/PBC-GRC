import React from 'react';
import { splitPolicyParagraph } from '../../data/telemetry/vmRemediationView';

/**
 * A narrative cell of the SSP preview. A paragraph the export generated from the vulnerability remediation policy (it starts with a fixed label) is set
 * apart from the recorded narrative, so nobody mistakes it for text a person wrote. Everything is a text node: nothing is interpreted as markup.
 */
export const GeneratedParagraphText: React.FC<{ text: string }> = ({ text }) => {
  const { recorded, generated } = splitPolicyParagraph(text);
  if (generated === null) return <>{text}</>;
  return (
    <>
      {recorded && <span className="block whitespace-pre-wrap">{recorded}</span>}
      <span className="mt-2 block whitespace-pre-wrap rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-2 text-amber-100">{generated}</span>
    </>
  );
};
