package proxy

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func pointerParts(pointer string) ([]string, error) {
	if pointer == "" {
		return nil, nil
	}
	if len(pointer) > 1024 || pointer[0] != '/' {
		return nil, ErrPolicy
	}
	parts := strings.Split(pointer[1:], "/")
	if len(parts) > 16 {
		return nil, ErrPolicy
	}
	for i, s := range parts {
		for j := 0; j < len(s); j++ {
			if s[j] == '~' {
				if j+1 >= len(s) || s[j+1] != '0' && s[j+1] != '1' {
					return nil, ErrPolicy
				}
				j++
			}
		}
		parts[i] = strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
	}
	return parts, nil
}

func projectResponse(resp *http.Response, p ResponsePolicy, values map[string]string) (any, error) {
	ct, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || ct != "application/json" && !(strings.HasPrefix(ct, "application/") && strings.HasSuffix(ct, "+json")) {
		return nil, ErrResponse
	}
	if encoding := resp.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return nil, ErrResponse
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, p.MaxBytes+1))
	if err != nil || int64(len(data)) > p.MaxBytes {
		return nil, ErrResponse
	}
	var value any
	if decodeStrict(data, &value) != nil {
		return nil, ErrResponse
	}
	parts, _ := pointerParts(p.JSONPointer)
	for _, part := range parts {
		switch v := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = v[part]
			if !ok {
				return nil, ErrResponse
			}
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(v) || strconv.Itoa(i) != part {
				return nil, ErrResponse
			}
			value = v[i]
		default:
			return nil, ErrResponse
		}
	}
	var out any
	switch v := value.(type) {
	case []any:
		if len(v) > p.MaxItems {
			return nil, ErrResponse
		}
		rows := make([]any, 0, len(v))
		for _, row := range v {
			r, err := projectRow(row, p.Fields)
			if err != nil {
				return nil, err
			}
			rows = append(rows, r)
		}
		out = rows
	default:
		out, err = projectRow(v, p.Fields)
		if err != nil {
			return nil, err
		}
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) > int(p.MaxBytes) || echoesSecret(encoded, values) {
		return nil, ErrResponse
	}
	return out, nil
}

func projectRow(value any, fields map[string]string) (map[string]any, error) {
	row, ok := value.(map[string]any)
	if !ok {
		return nil, ErrResponse
	}
	out := make(map[string]any, len(fields))
	for name, kind := range fields {
		v, exists := row[name]
		if !exists {
			return nil, ErrResponse
		}
		switch kind {
		case "date":
			s, ok := v.(string)
			if !ok || len(s) != 10 {
				return nil, ErrResponse
			}
			t, err := time.Parse("2006-01-02", s)
			if err != nil || t.Format("2006-01-02") != s {
				return nil, ErrResponse
			}
		case "number":
			n, ok := v.(json.Number)
			if !ok || len(n) > 64 {
				return nil, ErrResponse
			}
			f, err := n.Float64()
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return nil, ErrResponse
			}
		case "boolean":
			if _, ok := v.(bool); !ok {
				return nil, ErrResponse
			}
		case "string":
			s, ok := v.(string)
			if !ok || len(s) > 256 {
				return nil, ErrResponse
			}
		default:
			return nil, ErrResponse
		}
		out[name] = v
	}
	return out, nil
}

// Defense in depth, not a general data-loss-prevention guarantee. An upstream
// can split, encrypt or otherwise encode a secret, or use status/timing channels.
func echoesSecret(data []byte, values map[string]string) bool {
	output := string(data)
	for _, secret := range values {
		variants := []string{secret, url.QueryEscape(secret), url.PathEscape(secret),
			base64.StdEncoding.EncodeToString([]byte(secret)), base64.RawStdEncoding.EncodeToString([]byte(secret)),
			base64.URLEncoding.EncodeToString([]byte(secret)), base64.RawURLEncoding.EncodeToString([]byte(secret)),
			hex.EncodeToString([]byte(secret)), strings.ToUpper(hex.EncodeToString([]byte(secret)))}
		for _, variant := range variants {
			if variant == "" {
				continue
			}
			if strings.Contains(output, variant) {
				return true
			}
			encoded, _ := json.Marshal(variant)
			if len(encoded) > 2 && strings.Contains(output, string(encoded[1:len(encoded)-1])) {
				return true
			}
		}
	}
	return false
}
