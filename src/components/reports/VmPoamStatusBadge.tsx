import React from 'react';
import { CheckCircle2, CircleDashed, Clock, ShieldCheck, type LucideIcon } from 'lucide-react';
import { Badge, type BadgeTone } from '../common/Badge';
import { VM_POAM_STATUS_LABEL } from '../../data/reports/vmPoamItemForm';
import type { VmPoamStatus } from '../../types/vm';

const STYLE: Record<VmPoamStatus, { tone: BadgeTone; Icon: LucideIcon }> = {
  OPEN: { tone: 'amber', Icon: CircleDashed },
  IN_PROGRESS: { tone: 'cyan', Icon: Clock },
  COMPLETED: { tone: 'emerald', Icon: CheckCircle2 },
  RISK_ACCEPTED: { tone: 'indigo', Icon: ShieldCheck },
};

/** The status of a vulnerability POA&M item: the icon and the text carry it, not only the colour. */
export const VmPoamStatusBadge: React.FC<{ status: VmPoamStatus }> = ({ status }) => {
  const { tone, Icon } = STYLE[status];
  return (
    <Badge tone={tone} pill={false}>
      <Icon className="w-3 h-3" aria-hidden="true" />
      {VM_POAM_STATUS_LABEL[status]}
    </Badge>
  );
};
