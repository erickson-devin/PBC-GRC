import file from './objectives.generated.json';
import { setNist80053Objectives } from './objectives';

/** Server side: the SP 800-53A objectives are loaded when this module is imported. */
setNist80053Objectives((file as unknown as { objectives: Parameters<typeof setNist80053Objectives>[0] }).objectives);
