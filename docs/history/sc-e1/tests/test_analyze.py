import json, sys, os, unittest, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analyze import compute_metrics, _validate, SCHEMA_VERDICT

class TestAnalyze(unittest.TestCase):
    def _manifest(self):
        return {"run_id":"t1","thresholds":{"M1":0,"M2":0,"M3":1.0,"M4":1.0,"M5":0,"M6":0,"M7":0,"M8":0},"computed":{"wash_breakeven_volume":50000,"sybil_breakeven_pool":2000000,"eras_settled":100,"eras_expected":100}}
    def test_empty(self):
        m,v = compute_metrics([],self._manifest()); self.assertEqual(len(m),8)
    def test_active_agent(self):
        exp=[{"active":True,"stake":1000,"weight":0.5,"oracle_score":0}]
        m,v = compute_metrics(exp,self._manifest())
        self.assertEqual(next(x for x in m if x["name"]=="M1")["value"],1)
    def test_missing_threshold_raises(self):
        mn=self._manifest(); del mn["thresholds"]["M1"]
        with self.assertRaises(ValueError): compute_metrics([],mn)
    def test_schema_valid(self):
        m,v=compute_metrics([],self._manifest())
        _validate({"run_id":"t","metrics":m,"overall_verdict":v},SCHEMA_VERDICT)
if __name__=="__main__": unittest.main()
