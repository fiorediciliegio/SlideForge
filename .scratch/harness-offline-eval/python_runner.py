import json
import sys
import time
import unittest
from pathlib import Path

class MeasuredResult(unittest.TextTestResult):
    def startTest(self, test):
        self.started = time.perf_counter()
        super().startTest(test)

    def stopTest(self, test):
        failed = any(item[0] == test for item in self.failures + self.errors)
        rows.append({"type": "test:fail" if failed else "test:pass", "name": test.id(),
                     "ms": (time.perf_counter() - self.started) * 1000})
        super().stopTest(test)

rows = []
sys.path.insert(0, str(Path.cwd()))
loader = unittest.TestLoader()
suite = unittest.TestSuite(loader.discover("tests", pattern=name) for name in ["test_agent_models.py", "test_harness.py"])
result = unittest.TextTestRunner(verbosity=2, resultclass=MeasuredResult).run(suite)
Path(sys.argv[1]).write_text(json.dumps(rows, indent=2), encoding="utf-8")
sys.exit(0 if result.wasSuccessful() and result.testsRun else 1)
