package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"

	"github.com/TimLai666/veilsplice/internal/proxy"
)

func readInput(path string, max int64, stdin io.Reader) ([]byte, error) {
	var reader io.Reader
	if path == "-" {
		reader = stdin
	} else {
		f, err := os.Open(path)
		if err != nil {
			return nil, proxy.ErrInput
		}
		defer f.Close()
		reader = f
	}
	data, err := io.ReadAll(io.LimitReader(reader, max+1))
	if err != nil || int64(len(data)) > max {
		return nil, proxy.ErrInput
	}
	return data, nil
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		_ = json.NewEncoder(stderr).Encode(map[string]string{"error": err.Error()})
		return 1
	}
	flags := flag.NewFlagSet("veilsplice", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	policyPath := flags.String("policy", "", "trusted policy JSON file")
	requestPath := flags.String("request", "-", "request template JSON file or - for stdin")
	check := flags.Bool("check", false, "validate JSON and policy without reading secrets or using the network")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *policyPath == "" || *policyPath == "-" {
		return fail(proxy.ErrInput)
	}
	policyData, err := readInput(*policyPath, proxy.MaxPolicyBytes, stdin)
	if err != nil {
		return fail(err)
	}
	p, err := proxy.ParsePolicy(policyData)
	if err != nil {
		return fail(err)
	}
	requestData, err := readInput(*requestPath, proxy.MaxInputBytes, stdin)
	if err != nil {
		return fail(err)
	}
	t, err := proxy.ParseTemplate(requestData)
	if err != nil {
		return fail(err)
	}
	if _, ok := p.Targets[t.Target]; !ok {
		return fail(proxy.ErrDenied)
	}
	if *check {
		// Syntax/policy validation only; substitution/authorization is checked at execution.
		_ = json.NewEncoder(stdout).Encode(map[string]bool{"syntax_valid": true})
		return 0
	}
	c, err := proxy.New(p, proxy.NewEnvBackend(p))
	if err != nil {
		return fail(err)
	}
	result, err := c.Execute(context.Background(), requestData)
	if err != nil {
		return fail(err)
	}
	if json.NewEncoder(stdout).Encode(result) != nil {
		return 1
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
