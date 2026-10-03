package proxy

import (
	"context"
	"encoding/json"
	"regexp"
	"time"
)

// FinMindInputLimit and FinMindMaxCalendarDays are fixed limits, not caller options.
const FinMindInputLimit = 2048
const FinMindMaxCalendarDays = 31

var finmindStockID = regexp.MustCompile(`^[0-9]{4,6}$`)

// This policy is compiled into the specialized wrapper. Unlike the generic CLI,
// the wrapper accepts no policy path, destination, header, dataset or secret name.
const fixedFinMindPolicy = `{
  "secrets": {"finmind_token": "VEILSPLICE_FINMIND_TOKEN"},
  "targets": {
    "prices_anonymous": {
      "url": "https://api.finmindtrade.com/api/v4/data",
      "method": "GET", "secrets": [], "headers": [],
      "query": ["dataset", "data_id", "start_date", "end_date"], "body": "none",
      "response": {
        "json_pointer": "/data", "fields": {"date": "date", "open": "number", "close": "number"},
        "max_bytes": 65536, "max_items": 31
      }
    },
    "prices_authenticated": {
      "url": "https://api.finmindtrade.com/api/v4/data",
      "method": "GET", "secrets": ["finmind_token"], "headers": ["Authorization"],
      "query": ["dataset", "data_id", "start_date", "end_date"], "body": "none",
      "response": {
        "json_pointer": "/data", "fields": {"date": "date", "open": "number", "close": "number"},
        "max_bytes": 65536, "max_items": 31
      }
    },
    "usage_authenticated": {
      "url": "https://api.web.finmindtrade.com/v2/user_info",
      "method": "GET", "secrets": ["finmind_token"], "headers": ["Authorization"],
      "query": [], "body": "none",
      "response": {
        "json_pointer": "", "fields": {"user_count": "number", "api_request_limit": "number"},
        "max_bytes": 4096, "max_items": 1
      }
    }
  }
}`

type finmindInput struct {
	Operation string `json:"operation"`
	StockID   string `json:"stock_id,omitempty"`
	StartDate string `json:"start_date,omitempty"`
	EndDate   string `json:"end_date,omitempty"`
}

// FinMindRunner narrows the input surface, but does not provide OS isolation.
// A caller that controls the binary/environment/backend can still obtain secrets.
type FinMindRunner struct{ client *Client }

// NewFinMindRunner uses a fixed alias binding. A nil backend selects the demo
// environment adapter; production must supply an approved isolated backend.
// Backend injection is a trusted Go integration point, never a JSON/CLI option.
func NewFinMindRunner(backend SecretBackend) (*FinMindRunner, error) {
	p, err := ParsePolicy([]byte(fixedFinMindPolicy))
	if err != nil {
		return nil, ErrPolicy
	}
	if backend == nil {
		backend = NewEnvBackend(p)
	}
	c, err := New(p, backend)
	if err != nil {
		return nil, err
	}
	return &FinMindRunner{client: c}, nil
}

// ValidateFinMindInput checks the entire specialized request schema without
// resolving DNS, reading a secret, or making a network request.
func ValidateFinMindInput(input []byte) error { _, err := prepareFinMind(input); return err }

func (r *FinMindRunner) Execute(ctx context.Context, input []byte) (Result, error) {
	request, err := prepareFinMind(input)
	if err != nil {
		return Result{}, err
	}
	return r.client.Execute(ctx, request)
}

func prepareFinMind(input []byte) ([]byte, error) {
	var in finmindInput
	if len(input) > FinMindInputLimit || decodeStrict(input, &in) != nil {
		return nil, ErrInput
	}
	// Presence matters: usage forbids price parameters even when set to null/empty.
	var fields map[string]json.RawMessage
	if decodeStrict(input, &fields) != nil || fields == nil {
		return nil, ErrInput
	}
	for key, value := range fields {
		// encoding/json matches struct fields case-insensitively. Enforce exact
		// schema keys here to reject casing aliases and ambiguous duplicate forms.
		switch key {
		case "operation", "stock_id", "start_date", "end_date":
		default:
			return nil, ErrInput
		}
		if string(value) == "null" {
			return nil, ErrInput
		}
	}
	t := Template{Target: in.Operation}
	switch in.Operation {
	case "prices_anonymous", "prices_authenticated":
		if !finmindStockID.MatchString(in.StockID) {
			return nil, ErrInput
		}
		start, err := finmindDate(in.StartDate)
		if err != nil {
			return nil, err
		}
		end, err := finmindDate(in.EndDate)
		if err != nil {
			return nil, err
		}
		if end.Before(start) || end.Sub(start) > time.Duration(FinMindMaxCalendarDays-1)*24*time.Hour {
			return nil, ErrInput
		}
		t.Query = map[string]string{"dataset": "TaiwanStockPrice", "data_id": in.StockID, "start_date": in.StartDate, "end_date": in.EndDate}
		if in.Operation == "prices_authenticated" {
			t.Headers = map[string]string{"Authorization": "Bearer ${secret:finmind_token}"}
		}
	case "usage_authenticated":
		if len(fields) != 1 {
			return nil, ErrInput
		}
		t.Headers = map[string]string{"Authorization": "Bearer ${secret:finmind_token}"}
	default:
		return nil, ErrInput
	}
	out, err := json.Marshal(t)
	if err != nil {
		return nil, ErrInput
	}
	return out, nil
}

func finmindDate(value string) (time.Time, error) {
	if len(value) != 10 {
		return time.Time{}, ErrInput
	}
	t, err := time.Parse("2006-01-02", value)
	if err != nil || t.Format("2006-01-02") != value {
		return time.Time{}, ErrInput
	}
	return t, nil
}
