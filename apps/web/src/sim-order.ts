/** Online SIMs first; stable, so each group keeps the server order. Colours rank by slot/id, so reordering never recolours a SIM. */
export function simsOnlineFirst<T extends {present?:boolean|null;online?:boolean|null}>(sims:readonly T[]):T[]{const on=(s:T)=>s.present!==false&&!!s.online;return [...sims.filter(on),...sims.filter(s=>!on(s))];}
