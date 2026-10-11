module github.com/feder-cr/dots/guest/dot-agentd

go 1.25.0

// The Go that builds dot-agentd: CI's (setup-go reads this line), the smoke's (the golang image of this version),
// and a host's whose own Go is older (go downloads this one). The same source and this Go give the same bytes.
toolchain go1.26.8
