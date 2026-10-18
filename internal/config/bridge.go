package config

import (
	"errors"
	"fmt"
	"strings"
)

func (s SignalBridge) Validate() error {
	if !s.Enabled {
		return nil
	}
	if strings.TrimSpace(s.Account) == "" {
		return errors.New("bridges.signal.account: required when enabled")
	}
	if strings.TrimSpace(s.SignalCLI) == "" {
		return errors.New("bridges.signal.signal_cli: required when enabled")
	}
	if len(s.Allow) == 0 {
		return errors.New("bridges.signal.allow: at least one sender is required")
	}
	for _, sender := range s.Allow {
		if strings.TrimSpace(sender) == "" {
			return errors.New("bridges.signal.allow: empty sender")
		}
	}
	if len(s.Bind) == 0 {
		return errors.New("bridges.signal.bind: at least one conversation is required")
	}
	for conversation, channel := range s.Bind {
		validConversation := conversation == "self" || strings.HasPrefix(conversation, "group:") && len(conversation) > len("group:") || strings.HasPrefix(conversation, "direct:") && len(conversation) > len("direct:")
		if !validConversation {
			return fmt.Errorf("bridges.signal.bind: invalid conversation %q", conversation)
		}
		if strings.TrimSpace(channel) == "" {
			return fmt.Errorf("bridges.signal.bind[%q]: channel required", conversation)
		}
	}
	if s.Alerts != "" {
		if _, ok := s.Bind[s.Alerts]; !ok {
			return errors.New("bridges.signal.alerts: conversation must be bound")
		}
	}
	return nil
}
