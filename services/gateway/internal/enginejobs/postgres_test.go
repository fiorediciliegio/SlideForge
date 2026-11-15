package enginejobs

import (
	"encoding/json"
	"github.com/DATA-DOG/go-sqlmock"
	"testing"
	"time"
)

func TestPostgresClaimLocksSchedulerAndFencesExpiredAttempt(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	st := emptyState()
	now := time.Now().UTC()
	st.Jobs["engine-a"] = Job{ID: "engine-a", Request: Request{Owner: "owner", Kind: "validate"}, State: "running", Attempt: 1, LeaseToken: "expired", LeaseUntil: now.Add(-time.Second), QueuedAt: now.Add(-time.Minute)}
	payload, _ := json.Marshal(st)
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT payload FROM engine_queue WHERE id=1 FOR UPDATE`).WillReturnRows(sqlmock.NewRows([]string{"payload"}).AddRow(payload))
	mock.ExpectExec(`UPDATE engine_queue SET payload=\$1 WHERE id=1`).WithArgs(sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	s := newSQLStore(db, diskObjects(t.TempDir()))
	s.now = func() time.Time { return now }
	job, err := s.Claim("worker-b")
	if err != nil {
		t.Fatal(err)
	}
	if job.Attempt != 2 || job.LeaseToken == "expired" {
		t.Fatal("expired attempt was not fenced")
	}
	if err = mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
