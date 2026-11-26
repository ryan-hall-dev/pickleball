
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "checkin_attempts": {
                  Row: {
                    "created_at": string,"device_token_hash": string,"id": number,"ip_hash": string,"kind": Database["public"]['Enums']["checkin_attempt_kind"],"session_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"device_token_hash": string,"id"?: never,"ip_hash": string,"kind": Database["public"]['Enums']["checkin_attempt_kind"],"session_id": string
                  }
                  Update: {
                    "created_at"?: string,"device_token_hash"?: string,"id"?: never,"ip_hash"?: string,"kind"?: Database["public"]['Enums']["checkin_attempt_kind"],"session_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "checkin_attempts_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id"]
    }
                  ]
                },"checkin_requests": {
                  Row: {
                    "created_at": string,"decided_at": string | null,"decided_by": string | null,"device_token_hash": string,"first_name": string,"gender": string | null,"id": string,"ip_hash": string,"last_name": string,"session_id": string,"session_participant_id": string | null,"skill_level": Database["public"]['Enums']["skill_level"],"social_id": string,"status": Database["public"]['Enums']["checkin_request_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"device_token_hash": string,"first_name": string,"gender"?: string | null,"id"?: string,"ip_hash": string,"last_name": string,"session_id": string,"session_participant_id"?: string | null,"skill_level": Database["public"]['Enums']["skill_level"],"social_id": string,"status"?: Database["public"]['Enums']["checkin_request_status"]
                  }
                  Update: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"device_token_hash"?: string,"first_name"?: string,"gender"?: string | null,"id"?: string,"ip_hash"?: string,"last_name"?: string,"session_id"?: string,"session_participant_id"?: string | null,"skill_level"?: Database["public"]['Enums']["skill_level"],"social_id"?: string,"status"?: Database["public"]['Enums']["checkin_request_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "checkin_requests_session_id_social_id_fkey"
      columns: ["session_id","social_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id","social_id"]
    },{
      foreignKeyName: "checkin_requests_session_participant_id_fkey"
      columns: ["session_participant_id"]
isOneToOne: false
      referencedRelation: "session_participants"
      referencedColumns: ["id"]
    }
                  ]
                },"courts": {
                  Row: {
                    "created_at": string,"id": string,"is_active": boolean,"name": string,"social_id": string,"sort_order": number,"supported_formats": (Database["public"]['Enums']["court_format"])[],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"social_id": string,"sort_order"?: number,"supported_formats"?: (Database["public"]['Enums']["court_format"])[],"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"social_id"?: string,"sort_order"?: number,"supported_formats"?: (Database["public"]['Enums']["court_format"])[],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "courts_social_id_fkey"
      columns: ["social_id"]
isOneToOne: false
      referencedRelation: "socials"
      referencedColumns: ["id"]
    }
                  ]
                },"hosts": {
                  Row: {
                    "created_at": string,"display_name": string,"role": Database["public"]['Enums']["host_role"],"social_id": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name": string,"role"?: Database["public"]['Enums']["host_role"],"social_id": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"role"?: Database["public"]['Enums']["host_role"],"social_id"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "hosts_social_id_fkey"
      columns: ["social_id"]
isOneToOne: false
      referencedRelation: "socials"
      referencedColumns: ["id"]
    }
                  ]
                },"login_attempts": {
                  Row: {
                    "created_at": string,"email_hash": string,"id": number,"ip_hash": string,"kind": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email_hash": string,"id"?: never,"ip_hash": string,"kind": string
                  }
                  Update: {
                    "created_at"?: string,"email_hash"?: string,"id"?: never,"ip_hash"?: string,"kind"?: string
                  }
                  Relationships: [
                    
                  ]
                },"matches": {
                  Row: {
                    "court_id": string,"court_name": string,"created_at": string,"duration_seconds": number,"ended_at": string | null,"id": string,"session_id": string,"started_at": string,"status": Database["public"]['Enums']["match_row_status"],"team_a": (string)[],"team_b": (string)[],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "court_id": string,"court_name": string,"created_at"?: string,"duration_seconds": number,"ended_at"?: string | null,"id": string,"session_id": string,"started_at": string,"status": Database["public"]['Enums']["match_row_status"],"team_a": (string)[],"team_b": (string)[],"updated_at"?: string
                  }
                  Update: {
                    "court_id"?: string,"court_name"?: string,"created_at"?: string,"duration_seconds"?: number,"ended_at"?: string | null,"id"?: string,"session_id"?: string,"started_at"?: string,"status"?: Database["public"]['Enums']["match_row_status"],"team_a"?: (string)[],"team_b"?: (string)[],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "matches_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id"]
    }
                  ]
                },"roster_transfer_requests": {
                  Row: {
                    "created_at": string,"decided_at": string | null,"decided_by": string | null,"device_token_hash": string,"id": string,"roster_entry_id": string,"session_id": string,"social_id": string,"status": Database["public"]['Enums']["roster_transfer_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"device_token_hash": string,"id"?: string,"roster_entry_id": string,"session_id": string,"social_id": string,"status"?: Database["public"]['Enums']["roster_transfer_status"]
                  }
                  Update: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"device_token_hash"?: string,"id"?: string,"roster_entry_id"?: string,"session_id"?: string,"social_id"?: string,"status"?: Database["public"]['Enums']["roster_transfer_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "roster_transfer_requests_roster_entry_id_fkey"
      columns: ["roster_entry_id"]
isOneToOne: false
      referencedRelation: "session_roster_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "roster_transfer_requests_session_social_fkey"
      columns: ["session_id","social_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id","social_id"]
    }
                  ]
                },"saved_setups": {
                  Row: {
                    "config": NonNullable<Json>,"created_at": string,"host_id": string | null,"id": string,"last_used_at": string,"name": string,"social_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "config": NonNullable<Json>,"created_at"?: string,"host_id"?: string | null,"id"?: string,"last_used_at"?: string,"name": string,"social_id": string,"updated_at"?: string
                  }
                  Update: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"host_id"?: string | null,"id"?: string,"last_used_at"?: string,"name"?: string,"social_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "saved_setups_host_id_fkey"
      columns: ["host_id"]
isOneToOne: false
      referencedRelation: "hosts"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "saved_setups_social_id_fkey"
      columns: ["social_id"]
isOneToOne: false
      referencedRelation: "socials"
      referencedColumns: ["id"]
    }
                  ]
                },"session_events": {
                  Row: {
                    "actor_session_participant_id": string | null,"actor_user_id": string | null,"event_id": string,"occurred_at": string,"payload": NonNullable<Json>,"recorded_at": string,"seq": number,"session_id": string,"type": Database["public"]['Enums']["session_event_type"]
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_session_participant_id"?: string | null,"actor_user_id"?: string | null,"event_id": string,"occurred_at": string,"payload": NonNullable<Json>,"recorded_at"?: string,"seq": number,"session_id": string,"type": Database["public"]['Enums']["session_event_type"]
                  }
                  Update: {
                    "actor_session_participant_id"?: string | null,"actor_user_id"?: string | null,"event_id"?: string,"occurred_at"?: string,"payload"?: NonNullable<Json>,"recorded_at"?: string,"seq"?: number,"session_id"?: string,"type"?: Database["public"]['Enums']["session_event_type"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "session_events_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id"]
    }
                  ]
                },"session_participants": {
                  Row: {
                    "allows_same_name": boolean,"created_at": string,"first_name": string,"gender": string | null,"id": string,"last_name": string,"session_id": string,"skill_level": Database["public"]['Enums']["skill_level"] | null,"social_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "allows_same_name"?: boolean,"created_at"?: string,"first_name": string,"gender"?: string | null,"id"?: string,"last_name": string,"session_id": string,"skill_level"?: Database["public"]['Enums']["skill_level"] | null,"social_id": string
                  }
                  Update: {
                    "allows_same_name"?: boolean,"created_at"?: string,"first_name"?: string,"gender"?: string | null,"id"?: string,"last_name"?: string,"session_id"?: string,"skill_level"?: Database["public"]['Enums']["skill_level"] | null,"social_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "session_participants_session_id_social_id_fkey"
      columns: ["session_id","social_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id","social_id"]
    }
                  ]
                },"session_roster_entries": {
                  Row: {
                    "claimed_at": string | null,"claimed_device_token_hash": string | null,"created_at": string,"display_name": string | null,"guest_of_entry_id": string | null,"host_note": string | null,"id": string,"position": number,"session_id": string,"session_participant_id": string | null,"social_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "claimed_at"?: string | null,"claimed_device_token_hash"?: string | null,"created_at"?: string,"display_name"?: string | null,"guest_of_entry_id"?: string | null,"host_note"?: string | null,"id": string,"position": number,"session_id": string,"session_participant_id"?: string | null,"social_id": string
                  }
                  Update: {
                    "claimed_at"?: string | null,"claimed_device_token_hash"?: string | null,"created_at"?: string,"display_name"?: string | null,"guest_of_entry_id"?: string | null,"host_note"?: string | null,"id"?: string,"position"?: number,"session_id"?: string,"session_participant_id"?: string | null,"social_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "session_roster_entries_guest_of_entry_id_fkey"
      columns: ["guest_of_entry_id"]
isOneToOne: false
      referencedRelation: "session_roster_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "session_roster_entries_session_participant_id_fkey"
      columns: ["session_participant_id"]
isOneToOne: true
      referencedRelation: "session_participants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "session_roster_entries_session_social_fkey"
      columns: ["session_id","social_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id","social_id"]
    }
                  ]
                },"sessions": {
                  Row: {
                    "checkin_open": boolean,"config_snapshot": Json | null,"created_at": string,"draft_revision": number,"ended_at": string | null,"final_stats": Json | null,"host_id": string | null,"host_name": string,"id": string,"last_seq": number,"location": string | null,"name": string,"planned_end": string,"planned_start": string,"social_id": string,"started_at": string | null,"status": Database["public"]['Enums']["session_status"],"updated_at": string,"walk_ins_open": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "checkin_open"?: boolean,"config_snapshot"?: Json | null,"created_at"?: string,"draft_revision"?: number,"ended_at"?: string | null,"final_stats"?: Json | null,"host_id"?: string | null,"host_name": string,"id"?: string,"last_seq"?: number,"location"?: string | null,"name": string,"planned_end": string,"planned_start": string,"social_id": string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["session_status"],"updated_at"?: string,"walk_ins_open"?: boolean
                  }
                  Update: {
                    "checkin_open"?: boolean,"config_snapshot"?: Json | null,"created_at"?: string,"draft_revision"?: number,"ended_at"?: string | null,"final_stats"?: Json | null,"host_id"?: string | null,"host_name"?: string,"id"?: string,"last_seq"?: number,"location"?: string | null,"name"?: string,"planned_end"?: string,"planned_start"?: string,"social_id"?: string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["session_status"],"updated_at"?: string,"walk_ins_open"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "sessions_host_id_fkey"
      columns: ["host_id"]
isOneToOne: false
      referencedRelation: "hosts"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "sessions_social_id_fkey"
      columns: ["social_id"]
isOneToOne: false
      referencedRelation: "socials"
      referencedColumns: ["id"]
    }
                  ]
                },"socials": {
                  Row: {
                    "checkin_tag": string,"created_at": string,"id": string,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "checkin_tag"?: string,"created_at"?: string,"id"?: string,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "checkin_tag"?: string,"created_at"?: string,"id"?: string,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "add_draft_participant":
{ Args: { "p_actor_user_id": string,"p_first_name": string,"p_gender": string,"p_last_name": string,"p_session_id": string,"p_session_participant_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: string
                           },
"add_participant_mid_session":
{ Args: { "p_actor_user_id": string,"p_allows_same_name"?: boolean,"p_event_id": string,"p_expected_last_seq": number,"p_first_name": string,"p_gender": string,"p_last_name": string,"p_occurred_at": string,"p_session_id": string,"p_session_participant_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: Json
                           },
"append_session_event":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_expected_last_seq": number,"p_match_row"?: Json,"p_occurred_at": string,"p_payload": Json,"p_session_id": string,"p_type": Database["public"]['Enums']["session_event_type"] }; Returns: Json
                           },
"append_session_event_without_host":
{ Args: { "p_actor_session_participant_id"?: string,"p_event_id": string,"p_expected_last_seq": number,"p_occurred_at": string,"p_payload": Json,"p_session_id": string,"p_type": Database["public"]['Enums']["session_event_type"] }; Returns: Json
                           },
"apply_saved_setup":
{ Args: { "p_actor_user_id": string,"p_config_patch": Json,"p_duration_minutes": number,"p_expected_draft_revision": number,"p_location": string,"p_session_id": string,"p_setup_id": string }; Returns: Json
                           },
"approve_checkin":
{ Args: { "p_actor_user_id": string,"p_checkin_request_id": string,"p_event_id"?: string,"p_expected_last_seq"?: number,"p_gender"?: string,"p_occurred_at"?: string,"p_session_participant_id": string }; Returns: Json
                           },
"cancel_draft_session":
{ Args: { "p_actor_user_id": string,"p_session_id": string }; Returns: Json
                           },
"claim_roster_entry":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_expected_session_id": string,"p_first_name"?: string,"p_gender": string,"p_ip_hash": string,"p_last_name"?: string,"p_roster_entry_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: Json
                           },
"create_social_with_manager":
{ Args: { "p_manager_display_name": string,"p_manager_user_id": string,"p_name": string }; Returns: string
                           },
"decide_roster_transfer":
{ Args: { "p_actor_user_id": string,"p_should_move": boolean,"p_transfer_request_id": string }; Returns: Json
                           },
"end_session":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_expected_last_seq": number,"p_final_stats"?: Json,"p_occurred_at": string,"p_session_id": string }; Returns: Json
                           },
"get_checkin_page":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string }; Returns: Json
                           },
"get_checkin_participant":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_expected_session_id": string }; Returns: string
                           },
"host_check_in_roster_entry":
{ Args: { "p_actor_user_id": string,"p_event_id"?: string,"p_expected_last_seq"?: number,"p_first_name"?: string,"p_gender": string,"p_last_name"?: string,"p_occurred_at"?: string,"p_roster_entry_id": string,"p_session_id": string,"p_session_participant_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: Json
                           },
"import_roster_entries":
{ Args: { "p_actor_user_id": string,"p_entries": Json,"p_expected_entry_count": number,"p_session_id": string }; Returns: Json
                           },
"list_checkin_requests_for_open_session":
{ Args: { "p_actor_user_id": string }; Returns: {
              "created_at": string,"first_name": string,"gender": string,"id": string,"is_name_already_in_session": boolean,"last_name": string,"skill_level": Database["public"]['Enums']["skill_level"]
            }[]
                           },
"list_roster_for_open_session":
{ Args: { "p_actor_user_id": string }; Returns: Json
                           },
"record_login_attempt":
{ Args: { "p_email_hash": string,"p_ip_hash": string,"p_kind": string }; Returns: boolean
                           },
"reissue_checkin_tag":
{ Args: { "p_actor_user_id": string }; Returns: string
                           },
"reject_checkin":
{ Args: { "p_actor_user_id": string,"p_checkin_request_id": string }; Returns: Json
                           },
"remove_draft_participant":
{ Args: { "p_actor_user_id": string,"p_session_participant_id": string }; Returns: Json
                           },
"remove_roster_entry":
{ Args: { "p_actor_user_id": string,"p_roster_entry_id": string,"p_session_id": string }; Returns: Json
                           },
"request_roster_transfer":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_expected_session_id": string,"p_ip_hash": string,"p_roster_entry_id": string }; Returns: Json
                           },
"save_session_draft":
{ Args: { "p_actor_user_id": string,"p_config_patch": Json,"p_expected_draft_revision": number,"p_host_name": string,"p_location": string,"p_name": string,"p_planned_end": string,"p_planned_start": string,"p_session_id": string }; Returns: Json
                           },
"save_setup":
{ Args: { "p_actor_user_id": string,"p_config": Json,"p_name": string }; Returns: string
                           },
"search_roster_entries":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_expected_session_id": string,"p_ip_hash": string,"p_name_query": string }; Returns: Json
                           },
"set_draft_participant_details":
{ Args: { "p_actor_user_id": string,"p_expected_draft_revision": number,"p_gender": string,"p_participant_id": string,"p_session_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: Json
                           },
"set_roster_entry_note":
{ Args: { "p_actor_user_id": string,"p_host_note": string,"p_roster_entry_id": string,"p_session_id": string }; Returns: Json
                           },
"set_walk_ins_open":
{ Args: { "p_actor_user_id": string,"p_session_id": string,"p_walk_ins_open": boolean }; Returns: Json
                           },
"start_session":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_expected_draft_revision"?: number,"p_occurred_at": string,"p_payload": Json,"p_session_id": string }; Returns: Json
                           },
"submit_checkin":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_expected_session_id": string,"p_first_name": string,"p_gender": string,"p_ip_hash": string,"p_last_name": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: Json
                           }
          }
          Enums: {
            "checkin_attempt_kind": "search"|"submit"|"claim","checkin_request_status": "pending"|"approved"|"rejected"|"withdrawn","court_format": "doubles"|"singles","host_role": "manager"|"host","match_row_status": "completed"|"abandoned"|"reverted","roster_transfer_status": "pending"|"moved"|"kept"|"withdrawn","session_event_type": "SessionStarted"|"PlayerJoined"|"PlayerJoinReverted"|"PlayerLeft"|"PlayerLeaveReverted"|"PlayerSkipped"|"PlayerUnskipped"|"PlayerLocked"|"PlayerUnlocked"|"CourtAdded"|"CourtAddReverted"|"CourtClosed"|"CourtReopened"|"MatchStarted"|"MatchStartReverted"|"MatchCompleted"|"MatchCompletionReverted"|"PlayerReplaced"|"PlayerReplacementReverted"|"PlayerRemovedMidMatch"|"PlayerRemovalReverted"|"MatchAbandoned"|"MatchAbandonReverted"|"QueueReordered"|"SuggestionsShuffled"|"Paused"|"Resumed"|"SessionEnded"|"NextGroupCalled"|"NextGroupChanged"|"NextGroupReleased"|"NextGroupSeatConfirmed"|"NextGroupMoved"|"CourtCloseScheduled"|"CourtCloseCancelled","session_status": "draft"|"live"|"ended"|"cancelled","skill_level": "beginner"|"intermediate"|"advanced"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "checkin_attempt_kind": ["search", "submit", "claim"],"checkin_request_status": ["pending", "approved", "rejected", "withdrawn"],"court_format": ["doubles", "singles"],"host_role": ["manager", "host"],"match_row_status": ["completed", "abandoned", "reverted"],"roster_transfer_status": ["pending", "moved", "kept", "withdrawn"],"session_event_type": ["SessionStarted", "PlayerJoined", "PlayerJoinReverted", "PlayerLeft", "PlayerLeaveReverted", "PlayerSkipped", "PlayerUnskipped", "PlayerLocked", "PlayerUnlocked", "CourtAdded", "CourtAddReverted", "CourtClosed", "CourtReopened", "MatchStarted", "MatchStartReverted", "MatchCompleted", "MatchCompletionReverted", "PlayerReplaced", "PlayerReplacementReverted", "PlayerRemovedMidMatch", "PlayerRemovalReverted", "MatchAbandoned", "MatchAbandonReverted", "QueueReordered", "SuggestionsShuffled", "Paused", "Resumed", "SessionEnded", "NextGroupCalled", "NextGroupChanged", "NextGroupReleased", "NextGroupSeatConfirmed", "NextGroupMoved", "CourtCloseScheduled", "CourtCloseCancelled"],"session_status": ["draft", "live", "ended", "cancelled"],"skill_level": ["beginner", "intermediate", "advanced"]
          }
        }
} as const
