import { connect } from "./helpers.js";
const api = await connect();
console.log("spec", api.runtimeVersion.specVersion.toString());
console.log("consts", Object.entries(api.consts.orchestrator).map(([k,v]:any)=>k+"="+v.toString()).join(" "));
console.log("agents.fullFloorStake", api.consts.agents.fullFloorStake.toString(), "minStake", api.consts.agents.minStake.toString());
for (const n of ["Alice","Bob","Charlie"]) {
  const a = (await import("./helpers.js")).devAccounts()[n];
  console.log(n, "stake", (await api.query.agents.agentStake(a.address)).toString(),
   "orch", (await api.query.orchestrator.orchestratorRegistration(a.address)).toString());
}
await api.disconnect();
