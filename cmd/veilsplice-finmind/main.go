package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"

	"github.com/TimLai666/veilsplice/internal/proxy"
)

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		_ = json.NewEncoder(stderr).Encode(map[string]string{"error": err.Error()})
		return 1
	}
	flags := flag.NewFlagSet("veilsplice-finmind", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	check := flags.Bool("check", false, "validate fixed FinMind request without secrets or network")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return fail(proxy.ErrInput)
	}
	input, err := io.ReadAll(io.LimitReader(stdin, proxy.FinMindInputLimit+1))
	if err != nil {
		return fail(proxy.ErrInput)
	}
	if err = proxy.ValidateFinMindInput(input); err != nil {
		return fail(err)
	}
	if *check {
		_ = json.NewEncoder(stdout).Encode(map[string]bool{"request_valid": true})
		return 0
	}
	runner, err := proxy.NewFinMindRunner(nil)
	if err != nil {
		return fail(err)
	}
	result, err := runner.Execute(context.Background(), input)
	if err != nil {
		return fail(err)
	}
	if json.NewEncoder(stdout).Encode(result) != nil {
		return 1
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
