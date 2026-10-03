package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

// Validate duplicate keys before decoding; encoding/json otherwise accepts them.
func decodeStrict(data []byte, dst any) error {
	if !utf8.Valid(data) {
		return ErrInput
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := checkValue(d, 0); err != nil {
		return ErrInput
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrInput
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	d.UseNumber()
	if err := d.Decode(dst); err != nil {
		return ErrInput
	}
	return nil
}

func checkValue(d *json.Decoder, depth int) error {
	if depth > 32 {
		return ErrInput
	}
	t, err := d.Token()
	if err != nil {
		return ErrInput
	}
	switch t {
	case json.Delim('{'):
		seen := map[string]bool{}
		for d.More() {
			t, err = d.Token()
			key, ok := t.(string)
			if err != nil || !ok || seen[key] {
				return ErrInput
			}
			seen[key] = true
			if err = checkValue(d, depth+1); err != nil {
				return err
			}
		}
		t, err = d.Token()
		if err != nil || t != json.Delim('}') {
			return ErrInput
		}
	case json.Delim('['):
		for d.More() {
			if err = checkValue(d, depth+1); err != nil {
				return err
			}
		}
		t, err = d.Token()
		if err != nil || t != json.Delim(']') {
			return ErrInput
		}
	case json.Delim('}'), json.Delim(']'):
		return ErrInput
	}
	return nil
}
