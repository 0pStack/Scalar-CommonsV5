#!/usr/bin/env python3
"""SC-E1 Phase-0 economic simulator (model, NOT the chain).
MODEL ASSUMPTIONS (MA) — every result is conditional on these:
 MA-1 Era emission pool E_era is constant per era (parameter; sensitivity-swept).
 MA-2 Pool splits W:S = work-weighted : stake-weighted (default 60:40; RUN-B sets W=0).
 MA-3 Work weight_i = volume_i * rank_i * (1+0.10*oracle_acc_i) * (1+0.05*gov_i) * (1+velocity_i),
      velocity_i = min(0.30, 0.1 * volume_i/stake_i); only agents with volume >= MINVOL qualify for W.
 MA-4 Stake weight = stake, among heartbeated accounts.
 MA-5 Rank mult = 1.5 if completions in last 3 eras >= 50 else 1.0.
 MA-6 Oracle accuracy = share of votes matching honest consensus; colluders (<50% of set) deviating
      on 30% of questions score accordingly. Collusion cannot flip consensus below 50%.
 MA-7 Fees: 10 CMN burned per tx (heartbeat=1 tx; escrow=3 tx) + 100 CMN completion fee per escrow.
      Escrow principal nets to zero across the synthetic economy; emissions are the only income.
 MA-8 settle_era: any account may call when due (cost 10 CMN); rational rule: call if expected
      unclaimed earnings > fee; per-agent uniform random backoff over [0, 0.2*era] blocks.
"""
import random, statistics, json, itertools, math

CMN=1.0; TXFEE=10*CMN; COMPFEE=100*CMN; MINVOL=50*CMN
ESCROW_SIZE=100*CMN; RANK_N=50; RANK_W=3

class Ag:
    def __init__(s,aid,kind,stake,work=0.0):
        s.id=aid; s.kind=kind; s.stake=stake; s.work=work  # work = escrow volume/era
        s.earn=0.0; s.fees=0.0; s.hist=[]  # completions per era
    def vol(s): return s.work

def oracle_acc(kind,collude_frac):
    if kind=='A-5':  # deviate on 30% of questions; consensus stays honest (k<50%)
        return 0.9*(0.7)  # matching only on the 70% they answer honestly
    return 0.9

def run(seed, eras=20, E_era=1_000_000.0, wsplit=0.60, pop=None, collude_frac=0.0):
    rng=random.Random(seed)
    ags=[]
    aid=itertools.count()
    pop=pop or {}
    for v in pop.get('workers',[]):        # graded sub-cohorts
        for _ in range(pop.get('n_work',20)):
            ags.append(Ag(next(aid),'A-1',10_000*CMN,work=v))
    for _ in range(pop.get('n_stake',20)):
        ags.append(Ag(next(aid),'A-2',100_000*CMN))   # equal endowment, all staked
    for _ in range(pop.get('n_sybil',0)):
        ags.append(Ag(next(aid),'A-3',100*CMN))
    for _ in range(pop.get('n_wash',0)):
        ags.append(Ag(next(aid),'A-4',10_000*CMN,work=MINVOL))  # exactly qualifying via self-escrow
    n_or=pop.get('n_oracle',0)
    for _ in range(n_or):
        ags.append(Ag(next(aid),'A-5',10_000*CMN,work=500*CMN))
    lags=[]
    for era in range(eras):
        # activity + fees
        for a in ags:
            a.fees+=TXFEE  # heartbeat
            if a.vol()>0:
                n_esc=max(1,int(a.vol()/ESCROW_SIZE))
                a.fees+=n_esc*(3*TXFEE) + n_esc*COMPFEE if a.kind=='A-4' else n_esc*(1.5*TXFEE)+n_esc*(COMPFEE/2)
                # honest escrows: costs split between two worker counterparties (÷2); wash pays both sides
                a.hist.append(n_esc)
            else: a.hist.append(0)
        # weights
        Wq=[]; Sq=[]
        for a in ags:
            rank=1.5 if sum(a.hist[-RANK_W:])>=RANK_N else 1.0
            acc=oracle_acc(a.kind,collude_frac)
            gov=1.0 if a.kind in('A-1','A-5') else 0.0
            vel=min(0.30, 0.1*a.vol()/a.stake) if a.stake>0 else 0.0
            w=a.vol()*rank*(1+0.10*acc)*(1+0.05*gov)*(1+vel) if a.vol()>=MINVOL else 0.0
            Wq.append(w); Sq.append(a.stake)
        tw,ts=sum(Wq),sum(Sq)
        for a,w,s in zip(ags,Wq,Sq):
            if tw>0: a.earn+=E_era*wsplit*w/tw
            if ts>0: a.earn+=E_era*(1-wsplit)*s/ts
        # settlement (MA-8): first backoff among agents whose unclaimed earnings > fee
        eligible=[a for a in ags if a.earn/(era+1)>TXFEE]
        if eligible:
            lag=min(rng.uniform(0,0.2) for _ in eligible)
            caller=rng.choice(eligible); caller.fees+=TXFEE
            lags.append(lag)
        else: lags.append(None)
    return ags,lags

def net(a): return a.earn-a.fees
def by(ags,k): return [a for a in ags if a.kind==k]
def gini(x):
    x=sorted(x); n=len(x); s=sum(x)
    if s==0: return 0.0
    return sum((2*(i+1)-n-1)*v for i,v in enumerate(x))/(n*s)

def spearman(x,y):
    rx={v:i for i,v in enumerate(sorted(set(x)))}; ry=sorted(range(len(y)),key=lambda i:y[i])
    r_y=[0]*len(y)
    for rank,i in enumerate(ry): r_y[i]=rank
    r_x=[rx[v] for v in x]
    mx,my=statistics.mean(r_x),statistics.mean(r_y)
    num=sum((a-mx)*(b-my) for a,b in zip(r_x,r_y))
    den=math.sqrt(sum((a-mx)**2 for a in r_x)*sum((b-my)**2 for b in r_y))
    return num/den if den else 0.0

WORK_GRADES=[100,500,1000,2000,5000]
BASEPOP={'workers':WORK_GRADES,'n_work':20,'n_stake':100}
V={}; SEEDS=[1,2,3]
def agg(f): return [f(s) for s in SEEDS]

# RUN-A + RUN-B (P1,P2,P3,P8)
for name,ws_ in [('RUN-A',0.60),('RUN-B',0.0)]:
    ratios=[];rhos=[];g20=[];top=[]
    for s in SEEDS:
        ags,_=run(s,20,pop=BASEPOP,wsplit=ws_)
        wk,stk=by(ags,'A-1'),by(ags,'A-2')
        ratios.append(statistics.mean(net(a) for a in wk)/statistics.mean(net(a) for a in stk))
        rhos.append(spearman([a.work for a in wk],[net(a) for a in wk]))
        earns=[a.earn for a in ags]; g20.append(gini(earns)); top.append(max(earns)/sum(earns))
    V[name]={'ratio':ratios,'rho':rhos,'gini':g20,'top1':top}

# NC-3 label shuffle on RUN-A
ags,_=run(1,20,pop=BASEPOP,wsplit=0.60); wk=by(ags,'A-1')
xs=[a.work for a in wk]; ys=[net(a) for a in wk]; rng=random.Random(99)
perm=[]
for _ in range(100):
    xx=xs[:]; rng.shuffle(xx); perm.append(abs(spearman(xx,ys)))
V['NC-3']={'observed':spearman(xs,ys),'perm95':sorted(perm)[94]}

# RUN-C sybil (P4) + E_era sensitivity
def sybil_net(E):
    ags,_=run(1,3,E_era=E,pop={**BASEPOP,'n_sybil':1000})
    sy=by(ags,'A-3'); return sum(net(a) for a in sy)/len(sy)
V['RUN-C']={'net_at_1M':agg(lambda s: statistics.mean(net(a) for a in by(run(s,3,pop={**BASEPOP,'n_sybil':1000})[0],'A-3'))),
            'sweep':{f'{E:,.0f}':round(sybil_net(E),2) for E in [1e6,1e7,1e8,1e9]}}

# RUN-D wash (P5) + sensitivity
def wash_net(E,ws_=0.60):
    ags,_=run(1,10,E_era=E,wsplit=ws_,pop={**BASEPOP,'n_wash':2})
    wa=by(ags,'A-4'); return statistics.mean(net(a)/10 for a in wa)  # per era
V['RUN-D']={'net_per_era_at_1M':agg(lambda s: statistics.mean(net(a)/10 for a in by(run(s,10,pop={**BASEPOP,'n_wash':2})[0],'A-4'))),
            'sweep':{f'{E:,.0f}':round(wash_net(E),2) for E in [1e6,1e7,1e8,1e9]}}

# RUN-E oracle collusion (P6): uplift vs honest-equivalent worker at same volume
up=[]
for s in SEEDS:
    ags,_=run(s,10,pop={**BASEPOP,'n_oracle':20},collude_frac=0.2)
    col=statistics.mean(net(a) for a in by(ags,'A-5'))
    ref=statistics.mean(net(a) for a in by(ags,'A-1') if a.work==500)
    up.append(col/ref-1)
V['RUN-E']={'uplift':up}

# RUN-F liveness (P7): 100 eras, lag stats
_,lags=run(1,100,pop=BASEPOP)
ok=[l for l in lags if l is not None]
V['RUN-F']={'settled':len(ok),'p95_lag_frac':sorted(ok)[int(0.95*len(ok))-1]}

# NC-2 zero-work
ags,_=run(1,5,pop={'workers':[],'n_work':0,'n_stake':50})
V['NC-2']={'worker_metric':'undefined (no A-1 cohort)' if not by(ags,'A-1') else 'FABRICATED'}

print(json.dumps(V,indent=1,default=str))
json.dump(V,open('/home/claude/sc-e1/verdicts.json','w'),indent=1,default=str)
