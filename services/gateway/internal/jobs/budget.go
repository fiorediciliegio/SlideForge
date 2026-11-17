package jobs

import (
	"errors"
	"fmt"
	"math"
)

func money(value float64) float64 { return math.Round(value*1e6) / 1e6 }
func mutateBudget(run *AgentRun, c AgentCommand) error {
	if c.CallID == "" || math.IsNaN(c.Cost) || math.IsInf(c.Cost, 0) || c.Cost < 0 {
		return errors.New("无效模型调用或成本")
	}
	call, exists := run.Calls[c.CallID]
	if c.Action == "reserve_call" || c.Action == "send_call" {
		for _, other := range run.Calls {
			if other.Status == "unknown" {
				return ErrUnknownCall
			}
		}
	}
	switch c.Action {
	case "reserve_call":
		if exists {
			if call.InputHash != c.InputHash {
				return ErrAgentConflict
			}
			return nil
		}
		if run.Budget.ActiveSeconds >= run.Budget.LimitSeconds {
			return fmt.Errorf("%w：有效执行时间 %.0f / %.0f 秒", ErrBudgetExhausted, run.Budget.ActiveSeconds, run.Budget.LimitSeconds)
		}
		if money(run.Budget.SpentCNY+run.Budget.ReservedCNY+c.Cost) > run.Budget.LimitCNY {
			if money(run.Budget.SpentCNY+c.Cost) <= run.Budget.LimitCNY {
				for _, other := range run.Calls {
					if other.Status == "sent" || other.Status == "reserved" {
						return ErrBudgetInFlight
					}
				}
			}
			return fmt.Errorf("%w：剩余可用 ¥%.4f，本次需预留 ¥%.4f（已用 ¥%.4f / ¥%.4f，在途预留 ¥%.4f）", ErrBudgetExhausted, money(run.Budget.LimitCNY-run.Budget.SpentCNY-run.Budget.ReservedCNY), c.Cost, run.Budget.SpentCNY, run.Budget.LimitCNY, run.Budget.ReservedCNY)
		}
		run.Budget.ReservedCNY = money(run.Budget.ReservedCNY + c.Cost)
		run.Calls[c.CallID] = AgentCall{Status: "reserved", InputHash: c.InputHash, Cost: c.Cost}
	case "send_call":
		if !exists || call.Status != "reserved" {
			return ErrAgentConflict
		}
		if run.Budget.ActiveSeconds >= run.Budget.LimitSeconds {
			return fmt.Errorf("%w：有效执行时间 %.0f / %.0f 秒", ErrBudgetExhausted, run.Budget.ActiveSeconds, run.Budget.LimitSeconds)
		}
		call.Status = "sent"
		run.Calls[c.CallID] = call
	case "settle_call":
		if !exists {
			return ErrAgentConflict
		}
		if call.Status == "completed" {
			if call.ResponseRef != c.ResponseRef || call.Cost != c.Cost {
				return ErrAgentConflict
			}
			return nil
		}
		run.Budget.ReservedCNY = money(run.Budget.ReservedCNY - call.Cost)
		run.Budget.SpentCNY = money(run.Budget.SpentCNY + c.Cost)
		call.Status = "completed"
		call.Cost = c.Cost
		call.ResponseRef = c.ResponseRef
		call.Usage = c.Usage
		run.Calls[c.CallID] = call
	case "mark_unknown":
		if !exists {
			return ErrAgentConflict
		}
		if call.Status == "sent" {
			call.Status = "unknown"
			run.Calls[c.CallID] = call
		}
	case "reject_call":
		if !exists {
			return ErrAgentConflict
		}
		if call.Status == "rejected" {
			return nil
		}
		if call.Status != "sent" && call.Status != "reserved" {
			return ErrAgentConflict
		}
		run.Budget.ReservedCNY = money(run.Budget.ReservedCNY - call.Cost)
		call.Status = "rejected"
		run.Calls[c.CallID] = call
	}
	return nil
}
