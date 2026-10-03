.PHONY: test vet build check

test:
	go test -race ./...
vet:
	go vet ./...
build:
	go build -buildvcs=false -trimpath -o bin/veilsplice ./cmd/veilsplice
check: vet test build
