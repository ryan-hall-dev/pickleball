
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
                    "created_at": string,"decided_at": string | null,"decided_by": string | null,"device_token_hash": string,"first_name": string,"id": string,"ip_hash": string,"last_name": string,"member_id": string | null,"session_id": string,"session_participant_id": string | null,"skill_level": Database["public"]['Enums']["skill_level"] | null,"status": Database["public"]['Enums']["checkin_request_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"device_token_hash": string,"first_name": string,"id"?: string,"ip_hash": string,"last_name": string,"member_id"?: string | null,"session_id": string,"session_participant_id"?: string | null,"skill_level"?: Database["public"]['Enums']["skill_level"] | null,"status"?: Database["public"]['Enums']["checkin_request_status"]
                  }
                  Update: {
                    "created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"device_token_hash"?: string,"first_name"?: string,"id"?: string,"ip_hash"?: string,"last_name"?: string,"member_id"?: string | null,"session_id"?: string,"session_participant_id"?: string | null,"skill_level"?: Database["public"]['Enums']["skill_level"] | null,"status"?: Database["public"]['Enums']["checkin_request_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "checkin_requests_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "checkin_requests_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id"]
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
                    "created_at": string,"id": string,"is_active": boolean,"name": string,"sort_order": number,"supported_formats": (Database["public"]['Enums']["court_format"])[],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"sort_order"?: number,"supported_formats"?: (Database["public"]['Enums']["court_format"])[],"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"sort_order"?: number,"supported_formats"?: (Database["public"]['Enums']["court_format"])[],"updated_at"?: string
                  }
                  Relationships: [
                    
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
                },"member_devices": {
                  Row: {
                    "created_at": string,"last_seen_at": string,"member_id": string,"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"last_seen_at"?: string,"member_id": string,"token_hash": string
                  }
                  Update: {
                    "created_at"?: string,"last_seen_at"?: string,"member_id"?: string,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "member_devices_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    }
                  ]
                },"members": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"first_name": string,"id": string,"is_active": boolean,"last_checked_in_at": string | null,"last_name": string,"search_name": string,"skill_level": Database["public"]['Enums']["skill_level"] | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"first_name": string,"id"?: string,"is_active"?: boolean,"last_checked_in_at"?: string | null,"last_name": string,"search_name"?: never,"skill_level"?: Database["public"]['Enums']["skill_level"] | null,"updated_at"?: string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"first_name"?: string,"id"?: string,"is_active"?: boolean,"last_checked_in_at"?: string | null,"last_name"?: string,"search_name"?: never,"skill_level"?: Database["public"]['Enums']["skill_level"] | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"saved_setups": {
                  Row: {
                    "config": NonNullable<Json>,"created_at": string,"host_id": string,"id": string,"last_used_at": string,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "config": NonNullable<Json>,"created_at"?: string,"host_id": string,"id"?: string,"last_used_at"?: string,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"host_id"?: string,"id"?: string,"last_used_at"?: string,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "saved_setups_host_id_fkey"
      columns: ["host_id"]
isOneToOne: false
      referencedRelation: "hosts"
      referencedColumns: ["user_id"]
    }
                  ]
                },"session_events": {
                  Row: {
                    "actor_user_id": string,"event_id": string,"occurred_at": string,"payload": NonNullable<Json>,"recorded_at": string,"seq": number,"session_id": string,"type": Database["public"]['Enums']["session_event_type"]
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_user_id": string,"event_id": string,"occurred_at": string,"payload": NonNullable<Json>,"recorded_at"?: string,"seq": number,"session_id": string,"type": Database["public"]['Enums']["session_event_type"]
                  }
                  Update: {
                    "actor_user_id"?: string,"event_id"?: string,"occurred_at"?: string,"payload"?: NonNullable<Json>,"recorded_at"?: string,"seq"?: number,"session_id"?: string,"type"?: Database["public"]['Enums']["session_event_type"]
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
                    "created_at": string,"first_name": string,"id": string,"is_guest": boolean,"last_name": string,"member_id": string | null,"session_id": string,"skill_level": Database["public"]['Enums']["skill_level"] | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"first_name": string,"id"?: string,"is_guest"?: boolean,"last_name": string,"member_id"?: string | null,"session_id": string,"skill_level"?: Database["public"]['Enums']["skill_level"] | null
                  }
                  Update: {
                    "created_at"?: string,"first_name"?: string,"id"?: string,"is_guest"?: boolean,"last_name"?: string,"member_id"?: string | null,"session_id"?: string,"skill_level"?: Database["public"]['Enums']["skill_level"] | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "session_participants_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "session_participants_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id"]
    }
                  ]
                },"sessions": {
                  Row: {
                    "checkin_open": boolean,"config_snapshot": Json | null,"created_at": string,"draft_revision": number,"ended_at": string | null,"final_stats": Json | null,"host_id": string | null,"host_name": string,"id": string,"last_seq": number,"location": string | null,"name": string,"planned_end": string,"planned_start": string,"started_at": string | null,"status": Database["public"]['Enums']["session_status"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "checkin_open"?: boolean,"config_snapshot"?: Json | null,"created_at"?: string,"draft_revision"?: number,"ended_at"?: string | null,"final_stats"?: Json | null,"host_id"?: string | null,"host_name": string,"id"?: string,"last_seq"?: number,"location"?: string | null,"name": string,"planned_end": string,"planned_start": string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["session_status"],"updated_at"?: string
                  }
                  Update: {
                    "checkin_open"?: boolean,"config_snapshot"?: Json | null,"created_at"?: string,"draft_revision"?: number,"ended_at"?: string | null,"final_stats"?: Json | null,"host_id"?: string | null,"host_name"?: string,"id"?: string,"last_seq"?: number,"location"?: string | null,"name"?: string,"planned_end"?: string,"planned_start"?: string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["session_status"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sessions_host_id_fkey"
      columns: ["host_id"]
isOneToOne: false
      referencedRelation: "hosts"
      referencedColumns: ["user_id"]
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
            "add_draft_guest":
{ Args: { "p_actor_user_id": string,"p_first_name": string,"p_last_name": string,"p_session_id": string,"p_session_participant_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: string
                           },
"add_guest_mid_session":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_expected_last_seq": number,"p_first_name": string,"p_last_name": string,"p_occurred_at": string,"p_session_id": string,"p_session_participant_id": string,"p_skill_level": Database["public"]['Enums']["skill_level"] }; Returns: Json
                           },
"append_session_event":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_expected_last_seq": number,"p_match_row"?: Json,"p_occurred_at": string,"p_payload": Json,"p_session_id": string,"p_type": Database["public"]['Enums']["session_event_type"] }; Returns: Json
                           },
"apply_saved_setup":
{ Args: { "p_actor_user_id": string,"p_config_patch": Json,"p_duration_minutes": number,"p_expected_draft_revision": number,"p_location": string,"p_session_id": string,"p_setup_id": string }; Returns: Json
                           },
"approve_checkin":
{ Args: { "p_actor_user_id": string,"p_checkin_request_id": string,"p_event_id"?: string,"p_expected_last_seq"?: number,"p_occurred_at"?: string,"p_session_participant_id": string }; Returns: Json
                           },
"cancel_draft_session":
{ Args: { "p_actor_user_id": string,"p_session_id": string }; Returns: Json
                           },
"create_social_with_manager":
{ Args: { "p_manager_display_name": string,"p_manager_user_id": string,"p_name": string }; Returns: string
                           },
"end_session":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_expected_last_seq": number,"p_final_stats"?: Json,"p_occurred_at": string,"p_session_id": string }; Returns: Json
                           },
"record_login_attempt":
{ Args: { "p_email_hash": string,"p_ip_hash": string,"p_kind": string }; Returns: boolean
                           },
"reject_checkin":
{ Args: { "p_actor_user_id": string,"p_checkin_request_id": string }; Returns: Json
                           },
"remove_draft_guest":
{ Args: { "p_actor_user_id": string,"p_session_id": string,"p_session_participant_id": string }; Returns: Json
                           },
"remove_draft_participant":
{ Args: { "p_actor_user_id": string,"p_session_participant_id": string }; Returns: Json
                           },
"save_session_draft":
{ Args: { "p_actor_user_id": string,"p_config_patch": Json,"p_expected_draft_revision": number,"p_host_name": string,"p_location": string,"p_name": string,"p_planned_end": string,"p_planned_start": string,"p_session_id": string }; Returns: Json
                           },
"save_setup":
{ Args: { "p_actor_user_id": string,"p_config": Json,"p_name": string }; Returns: string
                           },
"search_checkin_names":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_ip_hash": string,"p_name_query": string }; Returns: {
              "first_name": string,"last_name": string,"member_id": string
            }[]
                           },
"set_draft_member_attendance":
{ Args: { "p_actor_user_id": string,"p_attending": boolean,"p_member_ids": (string)[],"p_session_id": string }; Returns: Json
                           },
"start_session":
{ Args: { "p_actor_user_id": string,"p_event_id": string,"p_occurred_at": string,"p_payload": Json,"p_session_id": string }; Returns: Json
                           },
"submit_checkin":
{ Args: { "p_checkin_tag": string,"p_device_token_hash": string,"p_first_name": string,"p_ip_hash": string,"p_last_name": string,"p_member_id"?: string,"p_skill_level"?: Database["public"]['Enums']["skill_level"] }; Returns: Json
                           }
          }
          Enums: {
            "checkin_attempt_kind": "search"|"submit","checkin_request_status": "pending"|"approved"|"rejected"|"withdrawn","court_format": "doubles"|"singles","host_role": "manager"|"host","match_row_status": "completed"|"abandoned"|"reverted","session_event_type": "SessionStarted"|"PlayerJoined"|"PlayerJoinReverted"|"PlayerLeft"|"PlayerLeaveReverted"|"PlayerSkipped"|"PlayerUnskipped"|"PlayerLocked"|"PlayerUnlocked"|"CourtAdded"|"CourtAddReverted"|"CourtClosed"|"CourtReopened"|"MatchStarted"|"MatchStartReverted"|"MatchCompleted"|"MatchCompletionReverted"|"PlayerReplaced"|"PlayerReplacementReverted"|"PlayerRemovedMidMatch"|"PlayerRemovalReverted"|"MatchAbandoned"|"MatchAbandonReverted"|"QueueReordered"|"SuggestionsShuffled"|"Paused"|"Resumed"|"SessionEnded","session_status": "draft"|"live"|"ended"|"cancelled","skill_level": "beginner"|"intermediate"|"advanced"
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
            "checkin_attempt_kind": ["search", "submit"],"checkin_request_status": ["pending", "approved", "rejected", "withdrawn"],"court_format": ["doubles", "singles"],"host_role": ["manager", "host"],"match_row_status": ["completed", "abandoned", "reverted"],"session_event_type": ["SessionStarted", "PlayerJoined", "PlayerJoinReverted", "PlayerLeft", "PlayerLeaveReverted", "PlayerSkipped", "PlayerUnskipped", "PlayerLocked", "PlayerUnlocked", "CourtAdded", "CourtAddReverted", "CourtClosed", "CourtReopened", "MatchStarted", "MatchStartReverted", "MatchCompleted", "MatchCompletionReverted", "PlayerReplaced", "PlayerReplacementReverted", "PlayerRemovedMidMatch", "PlayerRemovalReverted", "MatchAbandoned", "MatchAbandonReverted", "QueueReordered", "SuggestionsShuffled", "Paused", "Resumed", "SessionEnded"],"session_status": ["draft", "live", "ended", "cancelled"],"skill_level": ["beginner", "intermediate", "advanced"]
          }
        }
} as const
