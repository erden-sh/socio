// Decode a Docker ServiceSpec the way the engine does, and print canonical JSON.
//
//	check  DisallowUnknownFields, then remarshal. The proxy's forwarded
//	       body must survive this and match field for field.
//	fold   Case-insensitive decode. Unknown keys (including Spec) are dropped.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type file struct {
	Name string `json:"Name"`
	UID  string `json:"UID"`
	GID  string `json:"GID"`
	Mode int64  `json:"Mode"`
}

type secret struct {
	SecretID   string `json:"SecretID"`
	SecretName string `json:"SecretName"`
	File       file   `json:"File"`
}

type driverConfig struct {
	Name    string            `json:"Name,omitempty"`
	Options map[string]string `json:"Options,omitempty"`
}

type volumeOptions struct {
	DriverConfig *driverConfig `json:"DriverConfig,omitempty"`
}

type tmpfsOptions struct {
	SizeBytes int64 `json:"SizeBytes"`
	Mode      int64 `json:"Mode"`
}

type mount struct {
	Type          string         `json:"Type"`
	Source        string         `json:"Source,omitempty"`
	Target        string         `json:"Target"`
	VolumeOptions *volumeOptions `json:"VolumeOptions,omitempty"`
	TmpfsOptions  *tmpfsOptions  `json:"TmpfsOptions,omitempty"`
}

type health struct {
	Test        []string `json:"Test"`
	Interval    int64    `json:"Interval"`
	Timeout     int64    `json:"Timeout"`
	Retries     int64    `json:"Retries"`
	StartPeriod int64    `json:"StartPeriod"`
}

type container struct {
	Image          string            `json:"Image"`
	Labels         map[string]string `json:"Labels,omitempty"`
	Env            []string          `json:"Env"`
	User           string            `json:"User"`
	ReadOnly       bool              `json:"ReadOnly"`
	CapabilityDrop []string          `json:"CapabilityDrop"`
	Privileges     struct {
		NoNewPrivileges bool `json:"NoNewPrivileges"`
	} `json:"Privileges"`
	Secrets     []secret `json:"Secrets,omitempty"`
	Mounts      []mount  `json:"Mounts"`
	Healthcheck health   `json:"Healthcheck"`
}

type serviceSpec struct {
	Name         string            `json:"Name"`
	Labels       map[string]string `json:"Labels"`
	TaskTemplate struct {
		ContainerSpec container `json:"ContainerSpec"`
		Resources     struct {
			Limits struct {
				NanoCPUs    int64 `json:"NanoCPUs"`
				MemoryBytes int64 `json:"MemoryBytes"`
				Pids        int64 `json:"Pids"`
			} `json:"Limits"`
		} `json:"Resources"`
		RestartPolicy struct {
			Condition string `json:"Condition"`
		} `json:"RestartPolicy"`
		Networks []struct {
			Target string `json:"Target"`
		} `json:"Networks"`
		ForceUpdate *int64          `json:"ForceUpdate,omitempty"`
		Placement   json.RawMessage `json:"Placement,omitempty"`
	} `json:"TaskTemplate"`
	Mode struct {
		Replicated *struct {
			Replicas int64 `json:"Replicas"`
		} `json:"Replicated,omitempty"`
		Global *struct{} `json:"Global,omitempty"`
	} `json:"Mode"`
	EndpointSpec struct {
		Mode string `json:"Mode"`
	} `json:"EndpointSpec"`
	UpdateConfig   json.RawMessage `json:"UpdateConfig,omitempty"`
	RollbackConfig json.RawMessage `json:"RollbackConfig,omitempty"`
}

func main() {
	if len(os.Args) != 2 || (os.Args[1] != "check" && os.Args[1] != "fold") {
		fmt.Fprintln(os.Stderr, "usage: decode.go check|fold")
		os.Exit(2)
	}
	dec := json.NewDecoder(os.Stdin)
	if os.Args[1] == "check" {
		dec.DisallowUnknownFields()
	}
	var spec serviceSpec
	if err := dec.Decode(&spec); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(spec); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
